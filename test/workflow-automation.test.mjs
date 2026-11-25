// Offline test suite for Wave 2C automation. No network, no paid model calls, no live OpenCode
// service, and no writes outside per-test temp directories.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  InvalidJsonError,
  OpenRouterError,
  createOpenRouterClient,
  extractJsonObject,
  redactSecrets,
  sanitizeErrorCause,
  validateRequiredFields,
} from "../src/openrouter-client.mjs";
import {
  EmptyConsolidationError,
  HARD_MEMORY_LIMIT,
  MEMORY_INTERNALS,
  consolidateMemory,
  readAuditEntries,
  truncatePreservingSections,
} from "../src/memory-consolidate.mjs";
import {
  DEFAULT_MAX_USD_PER_SESSION,
  DEFAULT_MAX_USD_TOTAL,
  DEFAULT_MEMORY_MODEL,
  DEFAULT_SUPERVISOR_MODEL,
  DEFAULT_TOOL_CALL_CHECKPOINT,
  SUPERVISOR_ACTIONS,
  SUPERVISOR_INTERNALS,
  markMilestoneCompleted,
  normalizeDecision,
  parseMilestones,
  runSupervisor,
  spawnManagedServer,
  uncheckedMilestones,
} from "../src/supervisor.mjs";
import {
  formatRsiReport,
  protectedReportRoots,
  resolveSafeReportPath,
  runRsiPrune,
  writeRsiReport,
} from "../src/rsi-prune.mjs";
import auditPlugin from "../plugins/audit-logger/index.js";
import { syncGlobal } from "../scripts/sync-global.mjs";
import {
  APPROVED_MODELS,
  AUDIT_PLUGIN_ID,
  ENV_PROTECTED_ACTIONS,
  ENV_SAMPLE_BYPASS_COMMANDS,
  FILE_ACTIONS,
  MAX_SUBAGENT_STEPS,
  OPTIONAL_STEPS_SUBAGENTS,
  READ_ONLY_AGENTS,
  SHELL_ACTIONS,
  VERIFY_INTERNALS,
  WRITE_ACTIONS,
  inspectAuditEvidence,
  inspectPluginLoadLog,
  isApprovedModel,
  parseJsonc,
  resolveAuditDir,
  runBinaryChecks,
  stripJsonc,
  validateAgentsFile,
  validateConfig,
  validateResolvedConfig,
  verifySetup,
} from "../scripts/verify-setup.mjs";

function tempDir(t, prefix = "ocw-test-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeJsonl(file, entries) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
  return file;
}

/** Every JSONL record an audit directory currently holds, tolerant of a concurrent append. */
function allAuditRecords(dir) {
  if (!existsSync(dir)) return [];
  const records = [];
  for (const name of readdirSync(dir).filter((entry) => entry.endsWith(".jsonl")).sort()) {
    for (const line of readFileSync(join(dir, name), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        // A line caught mid-append; the next poll will see it whole.
      }
    }
  }
  return records;
}

async function waitFor(predicate, { timeout = 5000, interval = 20, message = "waitFor timed out" } = {}) {
  const startedAt = Date.now();
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- polling helper
    const value = await predicate();
    if (value) return value;
    if (Date.now() - startedAt > timeout) throw new Error(message);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

function auditEntry({ project = "alpha", workspace, session = "s1", type = "session.tool.called", timestamp, ...rest }) {
  return {
    timestamp: timestamp ?? new Date().toISOString(),
    project,
    workspace,
    sessionID: session,
    type,
    ...rest,
  };
}

function queuedLlm(queues) {
  const calls = [];
  const fn = async (request) => {
    calls.push(request);
    const queue = queues[request.purpose] ?? queues.default ?? [];
    if (queue.length === 0) throw new Error(`No queued response for purpose ${request.purpose}`);
    const value = queue.shift();
    if (typeof value === "string") return value;
    return JSON.stringify(value);
  };
  fn.calls = calls;
  return fn;
}

function fakeClient({ sessions = 2 } = {}) {
  const calls = { sessions: [], prompts: [], interrupts: [], switchAgents: [], waits: [] };
  let nextId = 0;
  const events = [];
  const client = {
    server: { info: async () => ({ version: "2.3.2" }) },
    session: {
      create: async (input) => {
        nextId += 1;
        const id = `s${nextId}`;
        calls.sessions.push({ id, input });
        return { id, title: input?.title };
      },
      prompt: async (input) => { calls.prompts.push(input); return { id: "inbox" }; },
      interrupt: async (input) => { calls.interrupts.push(input); },
      switchAgent: async (input) => { calls.switchAgents.push(input); },
      wait: async (input) => { calls.waits.push(input); },
      list: async () => ({ data: [] }),
    },
    message: { list: async () => ({ data: [] }) },
    event: {
      subscribe: () => (async function* generate() {
        for (const event of events) yield event;
      }()),
    },
    __events: events,
    __sessionsAvailable: sessions,
  };
  return { client, calls };
}

function toolCalled(session, index, tool = "read") {
  return { type: "session.tool.called", data: { sessionID: session, id: `t${index}`, tool, input: {} } };
}

function idle(session) {
  return { type: "session.idle", data: { sessionID: session } };
}

function usage(session, cost) {
  return { type: "session.usage.updated", data: { sessionID: session, cost, tokens: {} } };
}

function supervisorApproval(decisions) {
  return decisions.length ? decisions : [{ action: "complete", rationale: "milestone evidence is complete" }];
}

async function supervisorFixture(t, { action = "complete", events, decisions, extra = {}, memoryLlm = null }) {
  const workspace = tempDir(t, "ocw-supervisor-");
  writeFileSync(join(workspace, "PLAN.md"), "# Plan\n\n- [ ] Ship the bounded feature\n", "utf8");
  const decisionMessages = supervisorApproval(decisions ?? (action === "complete" ? [] : [
    { action, rationale: `exercise ${action}`, message: action === "steer" ? "use the failing test as evidence" : "" },
    { action: "complete", rationale: "done after the action" },
  ]));
  const llm = memoryLlm ?? queuedLlm({ decision: decisionMessages });
  const { client, calls } = fakeClient();
  const defaultEvents = action === "pause_for_human"
    ? Array.from({ length: 15 }, (_, index) => toolCalled("s1", index))
    : action === "complete"
      ? Array.from({ length: 15 }, (_, index) => toolCalled("s1", index))
      : action === "fresh_session"
        ? [
          ...Array.from({ length: 15 }, (_, index) => toolCalled("s1", index)),
          idle("s1"),
          idle("s2"),
        ]
        : [...Array.from({ length: 15 }, (_, index) => toolCalled("s1", index)), idle("s1")];
  client.__events.push(...(events ?? defaultEvents));
  const consolidateCalls = [];
  const consolidate = async (request) => {
    consolidateCalls.push(request);
    return { written: true, characters: 42, content: "# MEMORY\n" };
  };
  const logs = [];
  const webhookCalls = [];
  const result = await runSupervisor({
    workspace,
    planPath: join(workspace, "PLAN.md"),
    memoryPath: join(workspace, "MEMORY.md"),
    auditDir: join(workspace, ".audit"),
    notificationsLogPath: join(workspace, "notifications.log"),
    clientFactory: async () => client,
    llm,
    consolidate,
    log: (line) => logs.push(line),
    notifyWebhookUrl: "https://example.invalid/hook",
    fetchImpl: async (url, init) => { webhookCalls.push({ url, init }); return { ok: true }; },
    now: () => Date.parse("2026-11-22T09:00:00.000Z"),
    ...extra,
  });
  return { workspace, result, calls, llm, logs, webhookCalls, consolidateCalls };
}

describe("openrouter-client", () => {
  test("requires an API key without echoing it", () => {
    assert.throws(() => createOpenRouterClient({ apiKey: "" }), (error) => {
      assert.ok(error instanceof OpenRouterError);
      assert.equal(error.code, "missing_api_key");
      assert.match(error.message, /OPENROUTER_API_KEY/);
      return true;
    });
  });

  test("posts the expected body and returns message text", async () => {
    const requests = [];
    const fetchImpl = async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({ model: "test/model", choices: [{ message: { content: "hello" } }], usage: { total_tokens: 3 } }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const client = createOpenRouterClient({ apiKey: "sk-test-secret", fetchImpl, model: "test/model", timeoutMs: 1000 });
    const result = await client.chat({ messages: [{ role: "user", content: "hi" }], maxTokens: 10 });
    assert.equal(result.text, "hello");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].init.headers.authorization, "Bearer sk-test-secret");
    const body = JSON.parse(requests[0].init.body);
    assert.equal(body.model, "test/model");
    assert.equal(body.max_tokens, 10);
  });

  test("chatJson strips markdown fences and validates required fields", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({
      choices: [{ message: { content: "Here you go:\n```json\n{\"action\":\"continue\",\"rationale\":\"progress\",\"nested\":{\"ok\":true}}\n```\n" } }],
    }), { status: 200 });
    const client = createOpenRouterClient({ apiKey: "sk-test-secret", fetchImpl, timeoutMs: 1000 });
    const result = await client.chatJson({
      messages: [{ role: "user", content: "decide" }],
      requiredFields: ["action", "rationale", "nested.ok"],
    });
    assert.deepEqual(result.data, { action: "continue", rationale: "progress", nested: { ok: true } });
  });

  test("safe JSON extraction ignores braces inside strings", () => {
    const parsed = extractJsonObject('prefix {"a":"}{","b":[1,2]} suffix');
    assert.deepEqual(parsed, { a: "}{", b: [1, 2] });
    assert.throws(() => extractJsonObject("no object here"), InvalidJsonError);
    assert.throws(() => validateRequiredFields({ action: "" }, ["action"]), InvalidJsonError);
  });

  test("HTTP errors redact the API key", async () => {
    const key = "sk-live-should-never-appear";
    const fetchImpl = async () => new Response(`upstream rejected Bearer ${key}`, { status: 500 });
    const client = createOpenRouterClient({ apiKey: key, fetchImpl, timeoutMs: 1000 });
    await assert.rejects(client.chat({ messages: [{ role: "user", content: "hi" }] }), (error) => {
      assert.equal(error.code, "http_error");
      assert.equal(error.status, 500);
      assert.ok(!error.message.includes(key));
      assert.match(error.message, /REDACTED/);
      return true;
    });
    assert.equal(redactSecrets(`Bearer ${key}`, key), "Bearer [REDACTED]");
  });

  test("Error.cause is sanitized so an upstream fetch error cannot leak the API key", async () => {
    const key = "sk-cause-should-never-appear";
    const upstream = new Error(`request to https://openrouter.ai failed, authorization: Bearer ${key}`);
    upstream.code = `ECONN-${key}`;
    // Real fetch errors carry request/config objects that also hold the authorization header.
    upstream.request = { headers: { authorization: `Bearer ${key}` } };
    const fetchImpl = async () => { throw upstream; };
    const client = createOpenRouterClient({ apiKey: key, fetchImpl, timeoutMs: 1000 });
    await assert.rejects(client.chat({ messages: [{ role: "user", content: "hi" }] }), (error) => {
      assert.equal(error.code, "network_error");
      assert.ok(error.cause, "the cause is still available for diagnosis");
      const serialized = [
        String(error.cause),
        String(error.cause?.message ?? ""),
        String(error.cause?.code ?? ""),
        String(error.cause?.stack ?? ""),
        JSON.stringify(error.cause, Object.getOwnPropertyNames(error.cause)),
      ].join("\n");
      assert.ok(!serialized.includes(key), "the API key must not survive in error.cause");
      assert.match(error.cause.message, /REDACTED/);
      assert.equal(error.cause.request, undefined, "upstream request/config objects are never carried over");
      assert.equal(error.cause.cause, undefined, "the cause chain cannot reach the raw upstream error");
      return true;
    });

    // Direct unit check: a caller-supplied cause is rebuilt, never forwarded.
    const sanitized = sanitizeErrorCause(upstream, key);
    assert.equal(sanitized.request, undefined);
    assert.ok(!sanitized.message.includes(key));
    assert.ok(!String(sanitized.code).includes(key));
    assert.equal(sanitizeErrorCause(undefined, key), undefined);
  });

  test("network errors and timeouts never leak the key", async () => {
    const key = "sk-network-secret";
    const throwing = async () => { throw new Error(`connection failed with ${key}`); };
    const client = createOpenRouterClient({ apiKey: key, fetchImpl: throwing, timeoutMs: 1000 });
    await assert.rejects(client.chat({ messages: [{ role: "user", content: "hi" }] }), (error) => {
      assert.ok(!error.message.includes(key));
      assert.match(error.message, /REDACTED/);
      return true;
    });

    const timingOut = (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    });
    const timed = createOpenRouterClient({ apiKey: key, fetchImpl: timingOut, timeoutMs: 10 });
    await assert.rejects(timed.chat({ messages: [{ role: "user", content: "hi" }] }), (error) => {
      assert.equal(error.code, "timeout");
      assert.ok(!error.message.includes(key));
      return true;
    });
  });
});

describe("memory-consolidate", () => {
  test("enforces the hard 2,500-character ceiling, backs up, and writes atomically", async (t) => {
    const workspace = tempDir(t);
    const auditDir = join(workspace, ".audit");
    writeJsonl(join(auditDir, "audit.jsonl"), [
      auditEntry({ workspace, session: "s1", type: "session.tool.called", tool: "read" }),
      auditEntry({ workspace, session: "s1", type: "session.tool.failed", tool: "bash", error: "boom" }),
      auditEntry({ workspace, session: "s1", type: "session.usage.updated", model: "deepseek/deepseek-v4.1-flash-1017", cost: 0.02 }),
    ]);
    const memoryPath = join(workspace, "MEMORY.md");
    writeFileSync(memoryPath, "# MEMORY\n\nold content\n", "utf8");
    const oversized = `# MEMORY\n\n## Goal\n${"x".repeat(4000)}\n## Decisions\n${"y".repeat(1000)}`;
    const llm = queuedLlm({ consolidate: [oversized], compress: [oversized] });
    const result = await consolidateMemory({ workspace, auditDirs: [auditDir], llm, maxChars: 999_999, now: Date.parse("2026-11-22T09:00:00Z") });
    assert.equal(result.maxChars, HARD_MEMORY_LIMIT);
    assert.ok(result.characters <= HARD_MEMORY_LIMIT);
    assert.ok(result.content.trim().length > 0);
    assert.equal(result.status, "truncated");
    assert.equal(result.written, true);
    assert.equal(result.backupPath, `${memoryPath}.bak`);
    assert.equal(readFileSync(`${memoryPath}.bak`, "utf8"), "# MEMORY\n\nold content\n");
    assert.ok(Array.from(readFileSync(memoryPath, "utf8")).length <= HARD_MEMORY_LIMIT);
    assert.ok(!existsSync(`${memoryPath}.tmp`));
    assert.equal(llm.calls.filter((call) => call.purpose === "compress").length, 1);
  });

  test("a successful compression retry avoids truncation", async (t) => {
    const workspace = tempDir(t);
    const auditDir = join(workspace, ".audit");
    writeJsonl(join(auditDir, "audit.jsonl"), [auditEntry({ workspace })]);
    const llm = queuedLlm({ consolidate: [`# MEMORY\n${"z".repeat(3500)}`], compress: ["# MEMORY\n\n## Goal\nCompressed and useful.\n"] });
    const result = await consolidateMemory({ workspace, auditDirs: [auditDir], llm });
    assert.equal(result.status, "compressed");
    assert.equal(result.content, "# MEMORY\n\n## Goal\nCompressed and useful.");
  });

  test("section-preserving truncation keeps headings and stays non-empty", () => {
    const source = `# MEMORY\n\n## Goal\n${"a".repeat(1800)}\n\n## Decisions\n${"b".repeat(1800)}\n\n## Open issues\n${"c".repeat(1800)}`;
    const result = truncatePreservingSections(source, 2500);
    assert.ok(Array.from(result).length <= 2500);
    assert.ok(result.startsWith("# MEMORY"));
    assert.match(result, /## Goal/);
    assert.ok(result.trim().length > 0);
  });

  test("rejects empty model output without touching MEMORY.md", async (t) => {
    const workspace = tempDir(t);
    const auditDir = join(workspace, ".audit");
    writeJsonl(join(auditDir, "audit.jsonl"), [auditEntry({ workspace })]);
    const memoryPath = join(workspace, "MEMORY.md");
    writeFileSync(memoryPath, "# MEMORY\n\nkeep me\n", "utf8");
    const llm = queuedLlm({ consolidate: ["   "] });
    await assert.rejects(
      consolidateMemory({ workspace, auditDirs: [auditDir], llm }),
      (error) => error instanceof EmptyConsolidationError,
    );
    assert.equal(readFileSync(memoryPath, "utf8"), "# MEMORY\n\nkeep me\n");
    assert.ok(!existsSync(`${memoryPath}.bak`));
  });

  test("dry-run computes content but writes and backs up nothing", async (t) => {
    const workspace = tempDir(t);
    const auditDir = join(workspace, ".audit");
    writeJsonl(join(auditDir, "audit.jsonl"), [auditEntry({ workspace })]);
    const memoryPath = join(workspace, "MEMORY.md");
    writeFileSync(memoryPath, "old", "utf8");
    const llm = queuedLlm({ consolidate: ["# MEMORY\n\nnew"] });
    const result = await consolidateMemory({ workspace, auditDirs: [auditDir], llm, dryRun: true });
    assert.equal(result.written, false);
    assert.equal(readFileSync(memoryPath, "utf8"), "old");
    assert.ok(!existsSync(`${memoryPath}.bak`));
  });

  test("distinct absolute workspaces sharing a basename never match each other", (t) => {
    const root = tempDir(t, "ocw-workspace-match-");
    const alice = join(root, "alice", "shared");
    const bob = join(root, "bob", "shared");
    assert.equal(MEMORY_INTERNALS.pathMatchesWorkspace(alice, bob), false);
    assert.equal(MEMORY_INTERNALS.pathMatchesWorkspace(bob, alice), false);
    assert.equal(MEMORY_INTERNALS.pathMatchesWorkspace(join(alice, "src", "main.mjs"), alice), true);
    assert.equal(MEMORY_INTERNALS.pathMatchesWorkspace(alice, join(alice, "src")), false);
    assert.equal(MEMORY_INTERNALS.pathMatchesWorkspace("/work/./alice//shared/", "/work/alice/shared"), true);

    const auditDir = join(root, "audit");
    const now = Date.parse("2026-11-22T09:00:00Z");
    writeJsonl(join(auditDir, "audit.jsonl"), [
      auditEntry({ workspace: alice, project: "shared", session: "alice-1", timestamp: new Date(now - 1000).toISOString() }),
      auditEntry({ workspace: bob, project: "shared", session: "bob-1", timestamp: new Date(now - 900).toISOString() }),
      // A record with no workspace of its own must be attributed through its session, never
      // through a matching project basename.
      { project: "shared", sessionID: "orphan", type: "tool.before", tool: "read", timestamp: new Date(now - 800).toISOString() },
    ]);
    const aliceScan = readAuditEntries({ dirs: [auditDir], workspace: alice, days: 7, now });
    assert.deepEqual(aliceScan.entries.map((entry) => entry.__session), ["alice-1"]);
    const bobScan = readAuditEntries({ dirs: [auditDir], workspace: bob, days: 7, now });
    assert.deepEqual(bobScan.entries.map((entry) => entry.__session), ["bob-1"]);
    const nestedScan = readAuditEntries({ dirs: [auditDir], workspace: join(alice, "packages", "app"), days: 7, now });
    assert.deepEqual(nestedScan.entries, []);
  });

  test("a bare relative workspace label never matches an absolute workspace", (t) => {
    const root = tempDir(t, "ocw-relative-workspace-");
    // Fail closed: `shared` carries no absolute identity, so it could be /work/alice/shared or
    // /work/bob/shared. Basename equality across an absolute/relative mismatch must never match.
    assert.equal(MEMORY_INTERNALS.pathMatchesWorkspace("shared", "/work/alice/shared"), false);
    assert.equal(MEMORY_INTERNALS.pathMatchesWorkspace("/work/alice/shared", "shared"), false);
    assert.equal(MEMORY_INTERNALS.pathMatchesWorkspace("./shared/", "/work/alice/shared"), false);
    // Relative-to-relative comparison stays supported, where there is no absolute identity at all.
    assert.equal(MEMORY_INTERNALS.pathMatchesWorkspace("shared", "shared"), true);
    assert.equal(MEMORY_INTERNALS.pathMatchesWorkspace("shared/sub", "shared"), true);

    const auditDir = join(root, "audit");
    const now = Date.parse("2026-11-22T09:00:00Z");
    writeJsonl(join(auditDir, "audit.jsonl"), [
      auditEntry({ workspace: "/work/alice/shared", project: "shared", session: "abs-1", timestamp: new Date(now - 2000).toISOString() }),
      auditEntry({ workspace: "shared", project: "shared", session: "rel-1", timestamp: new Date(now - 1000).toISOString() }),
    ]);
    const scan = readAuditEntries({ dirs: [auditDir], workspace: "/work/alice/shared", days: 7, now });
    assert.deepEqual(
      scan.entries.map((entry) => entry.__session),
      ["abs-1"],
      "a relative 'shared' record must never be attributed to /work/alice/shared",
    );
  });

  test("an existing but empty MEMORY.md is backed up before being replaced", async (t) => {
    const workspace = tempDir(t, "ocw-empty-memory-");
    const auditDir = join(workspace, ".audit");
    writeJsonl(join(auditDir, "audit.jsonl"), [auditEntry({ workspace })]);
    const memoryPath = join(workspace, "MEMORY.md");
    writeFileSync(memoryPath, "", "utf8");
    assert.equal(statSync(memoryPath).size, 0);
    const llm = queuedLlm({ consolidate: ["# MEMORY\n\n## Goal\nRefilled after truncation.\n"] });
    const result = await consolidateMemory({ workspace, auditDirs: [auditDir], llm });
    assert.equal(result.written, true);
    assert.equal(result.backupPath, `${memoryPath}.bak`);
    assert.ok(existsSync(`${memoryPath}.bak`), "a 0-byte MEMORY.md is still prior state worth keeping");
    assert.equal(readFileSync(`${memoryPath}.bak`, "utf8"), "");
    assert.match(readFileSync(memoryPath, "utf8"), /Refilled after truncation/);
  });

  test("audit readers scope to a workspace and apply the day cutoff", (t) => {
    const workspace = tempDir(t);
    const auditDir = join(workspace, ".audit");
    const now = Date.parse("2026-11-22T09:00:00Z");
    writeJsonl(join(auditDir, "audit.jsonl"), [
      auditEntry({ workspace, session: "new", timestamp: new Date(now - 1000).toISOString() }),
      auditEntry({ workspace, session: "old", timestamp: new Date(now - 20 * 86_400_000).toISOString() }),
      auditEntry({ workspace: "/other/project", session: "foreign", timestamp: new Date(now - 1000).toISOString() }),
    ]);
    const scan = readAuditEntries({ dirs: [auditDir], workspace, days: 7, now });
    assert.deepEqual(scan.entries.map((entry) => entry.__session), ["new"]);
  });
});

describe("supervisor", () => {
  test("milestone parsing and atomic marking preserve other checklist items", (t) => {
    const workspace = tempDir(t);
    const planPath = join(workspace, "PLAN.md");
    const plan = "# Plan\n\n- [ ] first\n  - [x] nested done\n- [ ] second\n";
    writeFileSync(planPath, plan, "utf8");
    assert.equal(parseMilestones(plan).length, 3);
    assert.deepEqual(uncheckedMilestones(plan).map((item) => item.text), ["first", "second"]);
    const marked = markMilestoneCompleted(planPath, "first", { now: Date.parse("2026-11-22T09:00:00Z") });
    assert.equal(marked.changed, true);
    const updated = readFileSync(planPath, "utf8");
    assert.match(updated, /- \[x\] first/);
    assert.match(updated, /- \[ \] second/);
    assert.ok(!existsSync(`${planPath}.tmp`));
    assert.throws(() => markMilestoneCompleted(planPath, "missing"), /not found/);
  });

  test("normalizeDecision accepts known actions and falls back conservatively", () => {
    assert.deepEqual(normalizeDecision({ action: "complete", rationale: "done" }), { action: "complete", rationale: "done", message: "", fallback: false });
    const unknown = normalizeDecision({ action: "do_something_else", rationale: "x" }, { errors: 0 });
    assert.equal(unknown.action, "continue");
    assert.equal(unknown.fallback, true);
    const malformed = normalizeDecision("not json", { errors: 3 });
    assert.equal(malformed.action, "steer");
    assert.equal(malformed.fallback, true);
    assert.deepEqual(SUPERVISOR_ACTIONS, ["continue", "steer", "escalate_opus", "escalate_fable", "fresh_session", "complete", "pause_for_human"]);
    assert.equal(DEFAULT_TOOL_CALL_CHECKPOINT, 15);
    assert.equal(DEFAULT_MAX_USD_PER_SESSION, 15);
  });

  test("complete marks PLAN.md and invokes memory consolidation", async (t) => {
    const workspace = tempDir(t);
    const planPath = join(workspace, "PLAN.md");
    writeFileSync(planPath, "- [ ] Ship the bounded feature\n", "utf8");
    const memoryPath = join(workspace, "MEMORY.md");
    writeFileSync(memoryPath, "# MEMORY\n\nold\n", "utf8");
    const llm = async (request) => {
      if (request.purpose === "decision") return JSON.stringify({ action: "complete", rationale: "tests moved from fail to pass" });
      if (request.purpose === "consolidate") return "# MEMORY\n\n## Goal\nBounded feature shipped.\n";
      throw new Error(`unexpected purpose ${request.purpose}`);
    };
    const { client, calls } = fakeClient();
    client.__events.push(...Array.from({ length: 15 }, (_, index) => toolCalled("s1", index)));
    const result = await runSupervisor({
      workspace,
      planPath,
      memoryPath,
      auditDir: join(workspace, ".audit"),
      notificationsLogPath: join(workspace, "notifications.log"),
      clientFactory: async () => client,
      llm,
      log: () => {},
    });
    assert.equal(result.status, "completed_all");
    assert.deepEqual(result.completed, ["Ship the bounded feature"]);
    assert.match(readFileSync(planPath, "utf8"), /- \[x\] Ship the bounded feature/);
    assert.match(readFileSync(memoryPath, "utf8"), /Bounded feature shipped/);
    assert.equal(calls.sessions[0].input.agent, "build");
    assert.equal(calls.prompts[0].delivery, "queue");
    assert.match(calls.prompts[0].text, /Milestone from PLAN.md/);
    const auditLines = readFileSync(join(workspace, ".audit", "supervisor.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.ok(auditLines.some((entry) => entry.type === "supervisor.decision" && entry.action === "complete"));
    assert.ok(auditLines.some((entry) => entry.type === "supervisor.complete" && entry.memoryWritten === true));
  });

  test("continue, steer, and escalation actions keep driving the session", async (t) => {
    for (const action of ["continue", "steer", "escalate_opus", "escalate_fable"]) {
      const fixture = await supervisorFixture(t, { action });
      assert.equal(fixture.result.status, "completed_all", action);
      assert.equal(fixture.result.decisions[0].action, action);
      if (action === "steer") {
        assert.ok(fixture.calls.prompts.some((prompt) => prompt.text.includes("failing test")));
      }
      if (action === "escalate_opus") {
        assert.deepEqual(fixture.calls.switchAgents[0], { sessionID: "s1", agent: "escalate-opus" });
      }
      if (action === "escalate_fable") {
        assert.deepEqual(fixture.calls.switchAgents[0], { sessionID: "s1", agent: "escalate-fable" });
      }
      const audit = readFileSync(join(fixture.workspace, ".audit", "supervisor.jsonl"), "utf8");
      assert.match(audit, new RegExp(`"action":"${action}"`));
    }
  });

  test("fresh_session interrupts the old session and prompts a new one", async (t) => {
    const fixture = await supervisorFixture(t, { action: "fresh_session" });
    assert.equal(fixture.result.status, "completed_all");
    assert.deepEqual(fixture.calls.interrupts[0], { sessionID: "s1" });
    assert.equal(fixture.calls.sessions.length, 2);
    assert.equal(fixture.calls.sessions[1].id, "s2");
    assert.ok(fixture.calls.prompts.some((prompt) => prompt.sessionID === "s2" && /Milestone from PLAN.md/.test(prompt.text)));
    assert.match(readFileSync(join(fixture.workspace, ".audit", "supervisor.jsonl"), "utf8"), /"type":"supervisor.fresh_session"/);
  });

  test("pause_for_human prints exactly five lines, logs them, and calls the webhook", async (t) => {
    const fixture = await supervisorFixture(t, { action: "pause_for_human" });
    assert.equal(fixture.result.status, "paused");
    assert.equal(fixture.logs.length, 5);
    assert.match(fixture.logs[0], /^\[SUPERVISOR PAUSED\]/);
    assert.equal(fixture.webhookCalls.length, 1);
    const notification = readFileSync(join(fixture.workspace, "notifications.log"), "utf8").trimEnd().split("\n");
    assert.equal(notification.length, 5);
    assert.match(notification[1], /^Project: /);
    assert.match(readFileSync(join(fixture.workspace, "PLAN.md"), "utf8"), /- \[ \] Ship the bounded feature/);
    assert.match(readFileSync(join(fixture.workspace, ".audit", "supervisor.jsonl"), "utf8"), /"type":"supervisor.pause"/);
  });

  test("the $15 spend fuse pauses even without a model decision", async (t) => {
    const workspace = tempDir(t, "ocw-fuse-");
    writeFileSync(join(workspace, "PLAN.md"), "- [ ] costly milestone\n", "utf8");
    const { client } = fakeClient();
    client.__events.push(usage("s1", 15.01), idle("s1"));
    let llmCalls = 0;
    const logs = [];
    const result = await runSupervisor({
      workspace,
      planPath: join(workspace, "PLAN.md"),
      memoryPath: join(workspace, "MEMORY.md"),
      auditDir: join(workspace, ".audit"),
      notificationsLogPath: join(workspace, "notifications.log"),
      clientFactory: async () => client,
      llm: async () => { llmCalls += 1; return JSON.stringify({ action: "continue", rationale: "x" }); },
      consolidate: async () => ({ written: true }),
      log: (line) => logs.push(line),
      maxUsdPerSession: 15,
    });
    assert.equal(result.status, "paused");
    assert.equal(llmCalls, 0);
    assert.equal(logs.length, 5);
    assert.ok(logs.some((line) => /Spend fuse/.test(line)));
    assert.match(readFileSync(join(workspace, ".audit", "supervisor.jsonl"), "utf8"), /"type":"supervisor.spend_fuse"/);
    assert.match(readFileSync(join(workspace, "PLAN.md"), "utf8"), /- \[ \] costly milestone/);
  });

  test("defaults use the approved models and a finite cumulative spend fuse", async (t) => {
    const workspace = tempDir(t, "ocw-defaults-");
    writeFileSync(join(workspace, "PLAN.md"), "- [ ] defaults\n", "utf8");
    const options = { workspace, planPath: join(workspace, "PLAN.md"), dryRun: true };
    const result = await runSupervisor(options);
    assert.equal(result.status, "dry_run");
    assert.equal(DEFAULT_SUPERVISOR_MODEL, "deepseek/deepseek-v4.1-flash-1017");
    assert.equal(DEFAULT_MEMORY_MODEL, "deepseek/deepseek-v4.1-flash-1017");
    assert.equal(result.model, "deepseek/deepseek-v4.1-flash-1017");
    assert.equal(result.memoryModel, "deepseek/deepseek-v4.1-flash-1017");
    assert.equal(result.maxUsdPerSession, 15);
    assert.equal(DEFAULT_MAX_USD_TOTAL, 30);
    assert.equal(result.maxUsdTotal, 30, "the cumulative fuse defaults to 2x the session fuse");
    assert.ok(Number.isFinite(result.maxUsdTotal));
    assert.ok(result.maxUsdTotal < Number.MAX_SAFE_INTEGER);

    // The approved OCW-03 models can still be overridden, and the cumulative default follows.
    const overridden = await runSupervisor({ ...options, model: "openai/gpt-6-luna", memoryModel: "openai/gpt-6-luna" });
    assert.equal(overridden.model, "openai/gpt-6-luna");
    assert.equal(overridden.memoryModel, "openai/gpt-6-luna");
    const scaled = await runSupervisor({ ...options, maxUsdPerSession: 7 });
    assert.equal(scaled.maxUsdPerSession, 7);
    assert.equal(scaled.maxUsdTotal, 14);
  });

  test("non-finite or non-positive numeric options are rejected instead of silently disabling fuses", async (t) => {
    const workspace = tempDir(t, "ocw-bad-limit-");
    writeFileSync(join(workspace, "PLAN.md"), "- [ ] limits\n", "utf8");
    const base = { workspace, planPath: join(workspace, "PLAN.md"), dryRun: true };
    const cases = [
      ["maxUsdPerSession", Number.NaN],
      ["maxUsdPerSession", Number.POSITIVE_INFINITY],
      ["maxUsdPerSession", Number.NEGATIVE_INFINITY],
      ["maxUsdPerSession", -1],
      ["maxUsdPerSession", 0],
      ["maxUsdPerSession", "not-a-number"],
      ["maxUsdTotal", Number.NaN],
      ["maxUsdTotal", -0.5],
      ["toolCallCheckpoint", Number.NaN],
      ["toolCallCheckpoint", 0],
      ["toolCallCheckpoint", 2.5],
      ["toolCallCheckpoint", Number.POSITIVE_INFINITY],
      ["errorThreshold", Number.NaN],
      ["errorWindow", -3],
    ];
    for (const [option, value] of cases) {
      await assert.rejects(runSupervisor({ ...base, [option]: value }), (error) => {
        assert.equal(error.code, "invalid_supervisor_option", `${option}=${String(value)}`);
        assert.ok(error.message.includes(option), `${option}=${String(value)}: ${error.message}`);
        return true;
      }, `${option}=${String(value)} must be rejected`);
    }
    // A threshold larger than the window would never trip, which is the same as no fuse at all.
    await assert.rejects(
      runSupervisor({ ...base, errorThreshold: 9, errorWindow: 3 }),
      /must not exceed errorWindow/,
    );
    const accepted = await runSupervisor({ ...base, maxUsdPerSession: 5, maxUsdTotal: 7, toolCallCheckpoint: 3, errorThreshold: 2, errorWindow: 4 });
    assert.equal(accepted.maxUsdPerSession, 5);
    assert.equal(accepted.maxUsdTotal, 7);
    assert.equal(accepted.toolCallCheckpoint, 3);
  });

  test("an overflowing derived cumulative fuse is rejected instead of becoming Infinity", async (t) => {
    const workspace = tempDir(t, "ocw-overflow-fuse-");
    writeFileSync(join(workspace, "PLAN.md"), "- [ ] overflow fuse\n", "utf8");
    const base = { workspace, planPath: join(workspace, "PLAN.md"), dryRun: true };

    // `Number.MAX_VALUE` is finite and positive, so the per-session fuse itself passes validation.
    // The *derived* cumulative default (`MAX_VALUE * DEFAULT_MAX_USD_TOTAL_MULTIPLIER`) overflows to
    // Infinity, which would silently disable the cross-session fuse. It must be refused instead.
    await assert.rejects(runSupervisor({ ...base, maxUsdPerSession: Number.MAX_VALUE }), (error) => {
      assert.equal(error.code, "invalid_supervisor_option");
      assert.match(error.message, /maxUsdTotal/u, "the failure names the derived cumulative fuse");
      assert.match(error.message, /finite number greater than 0/u);
      return true;
    });
    // The exported validator refuses a non-finite fallback directly as well.
    assert.throws(
      () => SUPERVISOR_INTERNALS.strictPositiveNumber(undefined, Number.POSITIVE_INFINITY, "maxUsdTotal"),
      /maxUsdTotal must be a finite number greater than 0/u,
    );
    assert.throws(
      () => SUPERVISOR_INTERNALS.strictPositiveNumber(undefined, Number.MAX_VALUE * 2, "maxUsdTotal"),
      /maxUsdTotal must be a finite number greater than 0/u,
    );
    // An explicit finite pair still works and never yields a non-finite total.
    const explicit = await runSupervisor({ ...base, maxUsdPerSession: Number.MAX_VALUE, maxUsdTotal: 1e9 });
    assert.equal(explicit.maxUsdPerSession, Number.MAX_VALUE);
    assert.equal(explicit.maxUsdTotal, 1e9);
    assert.ok(Number.isFinite(explicit.maxUsdTotal));
  });

  test("fresh_session resets per-session spend while the cumulative total fuse still fires", async (t) => {
    const workspace = tempDir(t, "ocw-spend-epoch-");
    writeFileSync(join(workspace, "PLAN.md"), "- [ ] spend across sessions\n", "utf8");
    const { client, calls } = fakeClient();
    client.__events.push(
      usage("s1", 8),
      ...Array.from({ length: 15 }, (_, index) => toolCalled("s1", index)),
      usage("s2", 8),
    );
    const llm = queuedLlm({ decision: [{ action: "fresh_session", rationale: "the context is polluted" }] });
    const result = await runSupervisor({
      workspace,
      planPath: join(workspace, "PLAN.md"),
      memoryPath: join(workspace, "MEMORY.md"),
      auditDir: join(workspace, ".audit"),
      notificationsLogPath: join(workspace, "notifications.log"),
      clientFactory: async () => client,
      llm,
      consolidate: async () => ({ written: true }),
      log: () => {},
      maxUsdPerSession: 10,
      maxUsdTotal: 15,
    });
    assert.equal(result.status, "paused");
    assert.equal(calls.sessions.length, 2, "the fresh session was created");
    assert.ok(Math.abs(result.spentUsd - 16) < 1e-9, `cumulative spend must be $16, got ${result.spentUsd}`);
    const audit = readFileSync(join(workspace, ".audit", "supervisor.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    const fuse = audit.find((entry) => entry.type === "supervisor.spend_fuse");
    assert.ok(fuse, "a spend fuse entry was audited");
    assert.match(fuse.rationale, /maxUsdTotal/);
    assert.ok(!/maxUsdPerSession/.test(fuse.rationale), "the per-session fuse was not the one that fired");
    assert.equal(fuse.sessionSpentUsd, 8, "the new session was only charged its own $8");
    assert.equal(fuse.totalSpentUsd, 16);
    assert.equal(fuse.maxUsdTotal, 15);
    assert.match(readFileSync(join(workspace, "PLAN.md"), "utf8"), /- \[ \] spend across sessions/);
  });

  test("a fresh session resets the per-session counter instead of inheriting the previous one", async (t) => {
    const workspace = tempDir(t, "ocw-spend-reset-");
    writeFileSync(join(workspace, "PLAN.md"), "- [ ] reset the counter\n", "utf8");
    const { client } = fakeClient();
    client.__events.push(
      usage("s1", 8),
      ...Array.from({ length: 15 }, (_, index) => toolCalled("s1", index)),
      usage("s2", 8),
      idle("s2"),
    );
    const llm = queuedLlm({
      decision: [
        { action: "fresh_session", rationale: "start clean" },
        { action: "complete", rationale: "milestone finished" },
      ],
    });
    const result = await runSupervisor({
      workspace,
      planPath: join(workspace, "PLAN.md"),
      memoryPath: join(workspace, "MEMORY.md"),
      auditDir: join(workspace, ".audit"),
      notificationsLogPath: join(workspace, "notifications.log"),
      clientFactory: async () => client,
      llm,
      consolidate: async () => ({ written: true }),
      log: () => {},
      maxUsdPerSession: 10,
      maxUsdTotal: 30,
    });
    assert.equal(result.status, "completed_all", "$8 + $8 stays under the $10 per-session fuse");
    const audit = readFileSync(join(workspace, ".audit", "supervisor.jsonl"), "utf8");
    assert.ok(!/supervisor\.spend_fuse/.test(audit));
    const resumeDecision = JSON.parse(audit.trim().split("\n").find((line) => line.includes('"action":"complete"')));
    assert.equal(resumeDecision.costUSD, 8, "the decision sees the new epoch spend");
    assert.equal(resumeDecision.totalCostUSD, 16, "the decision also sees the cumulative spend");
  });

  test("telemetry prefers native tool names and terminal execution events trigger checkpoints", async (t) => {
    const workspace = tempDir(t, "ocw-telemetry-");
    writeFileSync(join(workspace, "PLAN.md"), "- [ ] telemetry labels\n", "utf8");
    const { client } = fakeClient();
    client.__events.push(
      { type: "session.tool.called", data: { sessionID: "s1", native: { name: "apply_patch" } } },
      { type: "session.tool.success", data: { sessionID: "s1", native: { name: "apply_patch" } } },
      { type: "session.execution.succeeded", data: { sessionID: "s1" } },
      { type: "session.execution.interrupted", data: { sessionID: "s1", reason: "supervisor" } },
    );
    const llm = queuedLlm({
      decision: [
        { action: "continue", rationale: "one turn finished" },
        { action: "complete", rationale: "milestone finished" },
      ],
    });
    const result = await runSupervisor({
      workspace,
      planPath: join(workspace, "PLAN.md"),
      memoryPath: join(workspace, "MEMORY.md"),
      auditDir: join(workspace, ".audit"),
      notificationsLogPath: join(workspace, "notifications.log"),
      clientFactory: async () => client,
      llm,
      consolidate: async () => ({ written: true }),
      log: () => {},
    });
    assert.equal(result.status, "completed_all");
    assert.deepEqual(
      result.decisions.map((decision) => decision.trigger),
      ["execution_succeeded", "execution_interrupted"],
    );
    const prompt = llm.calls[0].messages.map((message) => message.content).join("\n");
    assert.match(prompt, /Recent tool outcomes: apply_patch ok/u, "the native tool name reaches the supervisor prompt");
    assert.ok(!/Recent tool outcomes: tool ok/u.test(prompt));

    const { toolLabel } = SUPERVISOR_INTERNALS;
    assert.equal(toolLabel({ native: { name: "apply_patch" }, tool: "write" }), "apply_patch");
    assert.equal(toolLabel({ native: { name: "" }, tool: "bash", name: "shell", id: "t1" }), "bash");
    assert.equal(toolLabel({ name: "read", id: "t1" }), "read");
    assert.equal(toolLabel({ id: "call_42" }), "call_42");
    assert.equal(toolLabel({}), "tool");
  });

  test("malformed supervisor output falls back and still completes", async (t) => {
    const fixture = await supervisorFixture(t, {
      action: "continue",
      decisions: ["not json at all", { action: "complete", rationale: "recovered" }],
    });
    assert.equal(fixture.result.status, "completed_all");
    assert.equal(fixture.result.decisions[0].action, "continue");
    assert.equal(fixture.result.decisions[0].fallback, true);
    assert.equal(fixture.result.decisions[1].action, "complete");
  });

  test("spawnManagedServer parses the auth token without logging it", async () => {
    const password = "super-secret-token-value";
    const spawnImpl = () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.exitCode = null;
      child.killed = false;
      child.kill = () => { child.exitCode = 0; child.emit("exit", 0); };
      setImmediate(() => {
        child.stdout.emit("data", "server listening on http://127.0.0.1:4321\nserver " + password + "\n");
      });
      return child;
    };
    const server = await spawnManagedServer({ spawnImpl, timeoutMs: 1000 });
    assert.equal(server.baseUrl, "http://127.0.0.1:4321");
    assert.equal(server.password, password);
    assert.match(SUPERVISOR_INTERNALS.sanitizeSpawnOutput(`server ${password}`), /REDACTED/);
    assert.ok(!SUPERVISOR_INTERNALS.sanitizeSpawnOutput(`server ${password}`).includes(password));
    await server.close();
  });
});

describe("rsi-prune", () => {
  function rsiFixture(t, { projects = ["alpha"], sessionsPerProject = 3, skills = ["used-skill", "dead-skill"], agentsText = "# rules\n", configText = "{}" } = {}) {
    const root = tempDir(t, "ocw-rsi-");
    const auditDir = join(root, "audit");
    const entries = [];
    let counter = 0;
    for (const project of projects) {
      for (let s = 0; s < sessionsPerProject; s += 1) {
        const session = `${project}-s${s}`;
        for (let i = 0; i < 2; i += 1) {
          counter += 1;
          entries.push({ timestamp: new Date(Date.parse("2026-11-22T08:00:00Z") - counter * 1000).toISOString(), project, sessionID: session, type: "session.tool.called", tool: i === 0 ? "read" : "bash" });
        }
        entries.push({ timestamp: new Date(Date.parse("2026-11-22T08:00:00Z") - counter * 1000).toISOString(), project, sessionID: session, type: "session.skill.activated", skill: "used-skill" });
        entries.push({ timestamp: new Date(Date.parse("2026-11-22T08:00:00Z") - counter * 1000).toISOString(), project, sessionID: session, type: "session.usage.updated", model: "model/a", cost: 0.1 });
      }
    }
    writeJsonl(join(auditDir, "audit.jsonl"), entries);
    const agentsPath = join(root, "AGENTS.md");
    writeFileSync(agentsPath, agentsText, "utf8");
    const configPath = join(root, "opencode.jsonc");
    writeFileSync(configPath, configText, "utf8");
    return { root, auditDir, agentsPath, configPath, skills };
  }

  test("refuses global pruning with insufficient cross-project evidence", async (t) => {
    const fixture = rsiFixture(t, { projects: ["alpha"], sessionsPerProject: 3 });
    const beforeAgents = readFileSync(fixture.agentsPath, "utf8");
    const beforeConfig = readFileSync(fixture.configPath, "utf8");
    const report = await runRsiPrune({
      auditDirs: [fixture.auditDir],
      agentsPaths: [fixture.agentsPath],
      configPaths: [fixture.configPath],
      knownSkills: fixture.skills,
      days: 7,
      now: Date.parse("2026-11-22T09:00:00Z"),
    });
    assert.equal(report.guard.allowed, false);
    assert.equal(report.guard.distinctProjects, 1);
    assert.equal(report.guard.totalSessions, 3);
    assert.deepEqual(report.pruning.proposals, []);
    assert.ok(report.warnings.some((warning) => /CATASTROPHIC-FORGETTING/.test(warning) && /REFUSED/.test(warning)));
    assert.deepEqual(report.skills.unused, ["dead-skill"]);
    assert.equal(readFileSync(fixture.agentsPath, "utf8"), beforeAgents);
    assert.equal(readFileSync(fixture.configPath, "utf8"), beforeConfig);
    assert.match(formatRsiReport(report), /Pruning proposals: withheld/);
  });

  test("--force allows proposals but still reports the override", async (t) => {
    const fixture = rsiFixture(t, { projects: ["alpha"], sessionsPerProject: 2 });
    const report = await runRsiPrune({
      auditDirs: [fixture.auditDir],
      agentsPaths: [fixture.agentsPath],
      configPaths: [fixture.configPath],
      knownSkills: fixture.skills,
      force: true,
      now: Date.parse("2026-11-22T09:00:00Z"),
    });
    assert.equal(report.guard.allowed, true);
    assert.equal(report.guard.forced, true);
    assert.ok(report.guard.reason.includes("overridden"));
    assert.ok(report.pruning.proposals.some((proposal) => proposal.kind === "dead-skill" && proposal.target === "dead-skill"));
  });

  test("allows pruning with at least two projects and five sessions", async (t) => {
    const fixture = rsiFixture(t, { projects: ["alpha", "beta"], sessionsPerProject: 3 });
    const report = await runRsiPrune({
      auditDirs: [fixture.auditDir],
      agentsPaths: [fixture.agentsPath],
      configPaths: [fixture.configPath],
      knownSkills: fixture.skills,
      now: Date.parse("2026-11-22T09:00:00Z"),
    });
    assert.equal(report.guard.allowed, true);
    assert.equal(report.guard.distinctProjects, 2);
    assert.equal(report.guard.totalSessions, 6);
    assert.ok(report.pruning.allowed);
  });

  test("reports oversized AGENTS.md, dead skills, and Terra violations", async (t) => {
    const fixture = rsiFixture(t, {
      projects: ["alpha", "beta"],
      agentsText: "# rules\n" + "x".repeat(3200),
      configText: '{"model":"openai/gpt-6.1-terra-pro"}',
    });
    const report = await runRsiPrune({
      auditDirs: [fixture.auditDir],
      agentsPaths: [fixture.agentsPath],
      configPaths: [fixture.configPath],
      knownSkills: fixture.skills,
      now: Date.parse("2026-11-22T09:00:00Z"),
    });
    assert.equal(report.agents.hardExceeded, true);
    assert.ok(report.agents.files[0].chars > 3000);
    assert.equal(report.terra.ok, false);
    assert.ok(report.terra.violations.some((item) => item.match.includes("gpt-6.1-terra")));
    assert.ok(report.pruning.proposals.some((proposal) => proposal.kind === "agents-trim"));
    assert.ok(report.warnings.some((warning) => /hard ceiling/.test(warning)));
    assert.ok(report.warnings.some((warning) => /Terra is banned/.test(warning)));
  });

  test("reports tool/model error rates, permission blocks, and shell friction deterministically", async (t) => {
    const fixture = rsiFixture(t, { projects: ["alpha", "beta"], sessionsPerProject: 3 });
    const now = Date.parse("2026-11-22T09:00:00Z");
    // Both the permission and the shell pattern span five sessions across two projects, so each
    // proposal satisfies its OWN per-proposal evidence guard (see the dedicated guard test below).
    const at = (offset, entry) => ({ timestamp: new Date(now - offset).toISOString(), ...entry });
    appendFileSync(join(fixture.auditDir, "audit.jsonl"), [
      at(11_000, { project: "alpha", sessionID: "alpha-s0", type: "session.tool.failed", tool: "bash", error: "exit 1", input: { command: "npm test" } }),
      at(10_000, { project: "alpha", sessionID: "alpha-s0", type: "session.tool.failed", tool: "bash", error: "exit 1", input: { command: "npm test" } }),
      at(9_000, { project: "alpha", sessionID: "alpha-s0", type: "permission.decision", effect: "deny", resource: "git push origin main" }),
      at(8_500, { project: "alpha", sessionID: "alpha-s1", type: "session.tool.failed", tool: "bash", error: "exit 1", input: { command: "npm test" } }),
      at(8_000, { project: "alpha", sessionID: "alpha-s1", type: "permission.decision", effect: "deny", resource: "git push origin main" }),
      at(7_500, { project: "alpha", sessionID: "alpha-s2", type: "permission.decision", effect: "deny", resource: "git push origin main" }),
      at(7_000, { project: "beta", sessionID: "beta-s0", type: "session.tool.failed", tool: "bash", error: "exit 1", input: { command: "npm test" } }),
      at(6_000, { project: "beta", sessionID: "beta-s0", type: "permission.decision", effect: "blocked", resource: "git push origin main" }),
      at(5_000, { project: "beta", sessionID: "beta-s1", type: "session.tool.failed", tool: "bash", error: "exit 1", input: { command: "npm test" } }),
      at(4_500, { project: "beta", sessionID: "beta-s1", type: "permission.decision", effect: "deny", resource: "git push origin main" }),
      at(4_000, { project: "beta", sessionID: "beta-s2", type: "session.tool.failed", tool: "bash", error: "exit 1", input: { command: "npm test" } }),
      at(1_000, { project: "beta", sessionID: "beta-s0", type: "session.usage.updated", model: "model/b", cost: 0.4 }),
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");

    const options = {
      auditDirs: [fixture.auditDir],
      agentsPaths: [fixture.agentsPath],
      configPaths: [fixture.configPath],
      knownSkills: fixture.skills,
      now,
      days: 7,
    };
    const first = await runRsiPrune(options);
    const second = await runRsiPrune(options);
    assert.deepEqual(first, second);
    assert.ok(first.toolStats.calls >= 2);
    assert.ok(first.toolStats.errors >= 2);
    assert.ok(first.models.some((model) => model.model === "model/b" && model.costUSD >= 0.4));
    assert.ok(first.permissions.blocks >= 2);
    assert.ok(first.permissions.byResource.some((item) => item.resource === "git push origin main" && item.blocks >= 2));
    assert.ok(first.shell.failures.some((item) => item.command === "npm test" && item.failures >= 2));
    const permissionProposal = first.pruning.proposals.find((proposal) => proposal.kind === "permission-rule");
    assert.ok(permissionProposal);
    assert.equal(permissionProposal.target, "git push origin main");
    assert.deepEqual(permissionProposal.evidence, { distinctProjects: 2, sessions: 5, forced: false });
    const shellProposal = first.pruning.proposals.find((proposal) => proposal.kind === "shell-guidance");
    assert.ok(shellProposal);
    assert.equal(shellProposal.target, "npm test");
    assert.deepEqual(shellProposal.evidence, { distinctProjects: 2, sessions: 5, forced: false });
  });

  /** Appends a mixed log where the global guard passes but individual patterns stay single-project. */
  function mixedEvidenceFixture(t) {
    const fixture = rsiFixture(t, { projects: ["alpha", "beta"], sessionsPerProject: 3 });
    const now = Date.parse("2026-11-22T09:00:00Z");
    const at = (offset, entry) => ({ timestamp: new Date(now - offset).toISOString(), ...entry });
    appendFileSync(join(fixture.auditDir, "audit.jsonl"), [
      // Two permission blocks, but both inside project alpha.
      at(9000, { project: "alpha", sessionID: "alpha-s0", type: "permission.decision", effect: "deny", resource: "git push origin main" }),
      at(8000, { project: "alpha", sessionID: "alpha-s1", type: "permission.decision", effect: "deny", resource: "git push origin main" }),
      // alpha-only shell failures…
      at(7000, { project: "alpha", sessionID: "alpha-s0", type: "session.tool.failed", tool: "bash", error: "exit 1", input: { command: "cargo test" } }),
      at(6000, { project: "alpha", sessionID: "alpha-s1", type: "session.tool.failed", tool: "bash", error: "exit 1", input: { command: "cargo test" } }),
      // …and beta-only shell failures: two projects exist in the log, but not for the same claim.
      at(5000, { project: "beta", sessionID: "beta-s0", type: "session.tool.failed", tool: "bash", error: "exit 1", input: { command: "npm test" } }),
      at(4000, { project: "beta", sessionID: "beta-s1", type: "session.tool.failed", tool: "bash", error: "exit 1", input: { command: "npm test" } }),
      at(3000, { project: "beta", sessionID: "beta-s2", type: "session.tool.failed", tool: "bash", error: "exit 1", input: { command: "npm test" } }),
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    return { fixture, now };
  }

  test("a single-project evidence pattern is never proposed globally just because a second project exists", async (t) => {
    const { fixture, now } = mixedEvidenceFixture(t);
    const options = {
      auditDirs: [fixture.auditDir],
      agentsPaths: [fixture.agentsPath],
      configPaths: [fixture.configPath],
      knownSkills: fixture.skills,
      now,
    };
    const report = await runRsiPrune(options);
    assert.equal(report.guard.allowed, true, "the whole log does satisfy the global 2-project/5-session guard");
    assert.equal(report.guard.distinctProjects, 2);

    const withheld = new Map(report.pruning.withheld.map((proposal) => [`${proposal.kind}:${proposal.target}`, proposal]));
    const push = withheld.get("permission-rule:git push origin main");
    assert.ok(push, "a permission pattern proven in one project must not become a global rule proposal");
    assert.deepEqual(push.evidence, { distinctProjects: 1, sessions: 2, forced: false });
    assert.match(push.withheldReason, /at least 2 projects and 5 sessions/u);
    assert.ok(withheld.has("shell-guidance:npm test"));
    assert.ok(withheld.has("shell-guidance:cargo test"));
    assert.deepEqual(
      report.pruning.proposals.filter((proposal) => ["permission-rule", "shell-guidance"].includes(proposal.kind)),
      [],
    );
    assert.ok(report.warnings.some((warning) => /PER-PROPOSAL GUARD/u.test(warning) && warning.includes("git push origin main")));
    assert.match(formatRsiReport(report), /Proposals withheld by the per-proposal forgetting guard/u);

    // --force still emits them, but records the override on each proposal and in the warnings.
    const forced = await runRsiPrune({ ...options, force: true });
    const forcedPush = forced.pruning.proposals.find((proposal) => proposal.kind === "permission-rule" && proposal.target === "git push origin main");
    assert.ok(forcedPush);
    assert.equal(forcedPush.evidence.forced, true);
    assert.equal(forcedPush.evidence.distinctProjects, 1);
    assert.ok(forced.warnings.some((warning) => /--force overrode its per-proposal evidence guard/u.test(warning)));
  });

  test("a session-less record cannot supply the second project that unlocks the per-proposal guard", async (t) => {
    const root = tempDir(t, "ocw-rsi-sessionless-");
    const auditDir = join(root, "audit");
    const now = Date.parse("2026-11-22T09:00:00Z");
    const at = (offset, entry) => ({ timestamp: new Date(now - offset).toISOString(), ...entry });
    const PUSH = "git push origin main";
    const entries = [];
    // alpha: five real sessions, all blocked on the same command (real single-project evidence).
    for (let index = 0; index < 5; index += 1) {
      entries.push(at(20_000 - index * 1000, { project: "alpha", sessionID: `alpha-s${index}`, type: "permission.decision", effect: "deny", resource: PUSH }));
    }
    // beta: one record with NO session at all that repeats the same block. It must not count as a
    // second project: it carries no history, so it cannot unlock a global change.
    entries.push(at(10_000, { project: "beta", type: "permission.decision", effect: "deny", resource: PUSH }));
    // gamma: one unrelated real session keeps the GLOBAL 2-project/5-session guard satisfied.
    entries.push(at(9_000, { project: "gamma", sessionID: "gamma-s0", type: "session.tool.called", tool: "read" }));
    writeJsonl(join(auditDir, "audit.jsonl"), entries);

    const agentsPath = join(root, "AGENTS.md");
    const configPath = join(root, "opencode.jsonc");
    writeFileSync(agentsPath, "# rules\n", "utf8");
    writeFileSync(configPath, "{}", "utf8");

    const report = await runRsiPrune({
      auditDirs: [auditDir],
      agentsPaths: [agentsPath],
      configPaths: [configPath],
      knownSkills: [],
      days: 7,
      now,
    });
    assert.equal(report.guard.allowed, true, "alpha + gamma satisfy the global guard");
    assert.equal(report.guard.distinctProjects, 2);
    assert.equal(report.guard.totalSessions, 6);

    const withheld = report.pruning.withheld.find((proposal) => proposal.kind === "permission-rule" && proposal.target === PUSH);
    assert.ok(withheld, "the pattern must be withheld, not proposed");
    assert.equal(withheld.evidence.distinctProjects, 1, "beta's session-less record is not a second project");
    assert.equal(withheld.evidence.sessions, 5);
    assert.match(withheld.withheldReason, /at least 2 projects and 5 sessions/u);
    assert.deepEqual(
      report.pruning.proposals.filter((proposal) => proposal.kind === "permission-rule"),
      [],
      "no global permission proposal may be emitted",
    );
    assert.ok(report.warnings.some((warning) => /PER-PROPOSAL GUARD/u.test(warning) && warning.includes(PUSH)));
  });

  test("session-less records cannot add a project to model-routing or dead-skill evidence", async (t) => {
    const root = tempDir(t, "ocw-rsi-sessionless-model-");
    const auditDir = join(root, "audit");
    const now = Date.parse("2026-11-22T09:00:00Z");
    const at = (offset, entry) => ({ timestamp: new Date(now - offset).toISOString(), ...entry });
    const entries = [];
    // alpha: five real sessions whose model turns all errored (real single-project evidence).
    for (let index = 0; index < 5; index += 1) {
      entries.push(at(20_000 - index * 1000, { project: "alpha", sessionID: `alpha-s${index}`, type: "session.usage.updated", model: "model/a", cost: 0.1, error: "boom" }));
      entries.push(at(19_500 - index * 1000, { project: "alpha", sessionID: `alpha-s${index}`, type: "session.skill.activated", skill: "used-skill" }));
    }
    // beta: one model+skill record with NO session at all. It must not count as a second project
    // for either the model-routing or the dead-skill evidence set.
    entries.push(at(10_000, { project: "beta", type: "session.usage.updated", model: "model/a", cost: 0.1, error: "boom" }));
    entries.push(at(9_900, { project: "beta", type: "session.skill.activated", skill: "used-skill" }));
    // gamma: one unrelated real session keeps the GLOBAL 2-project/5-session guard satisfied.
    entries.push(at(9_000, { project: "gamma", sessionID: "gamma-s0", type: "session.tool.called", tool: "read" }));
    writeJsonl(join(auditDir, "audit.jsonl"), entries);

    const agentsPath = join(root, "AGENTS.md");
    const configPath = join(root, "opencode.jsonc");
    writeFileSync(agentsPath, "# rules\n", "utf8");
    writeFileSync(configPath, "{}", "utf8");

    const report = await runRsiPrune({
      auditDirs: [auditDir],
      agentsPaths: [agentsPath],
      configPaths: [configPath],
      knownSkills: ["used-skill", "dead-skill"],
      days: 7,
      now,
    });
    assert.equal(report.guard.allowed, true, "alpha + gamma satisfy the global guard");
    assert.equal(report.guard.distinctProjects, 2);
    assert.equal(report.guard.totalSessions, 6);

    const model = report.models.find((item) => item.model === "model/a");
    assert.ok(model);
    assert.equal(model.turns, 6);
    assert.deepEqual(model.evidence, { distinctProjects: 1, sessions: 5 }, "beta's session-less turn is not a second project");

    const withheld = new Map(report.pruning.withheld.map((proposal) => [`${proposal.kind}:${proposal.target}`, proposal]));
    const withheldModel = withheld.get("model-routing:model/a");
    assert.ok(withheldModel, "the model-routing proposal must be withheld, not emitted");
    assert.deepEqual(withheldModel.evidence, { distinctProjects: 1, sessions: 5, forced: false });
    const withheldSkill = withheld.get("dead-skill:dead-skill");
    assert.ok(withheldSkill, "the dead-skill proposal must be withheld, not emitted");
    assert.deepEqual(withheldSkill.evidence, { distinctProjects: 1, sessions: 5, forced: false });

    assert.deepEqual(
      report.pruning.proposals.filter((proposal) => proposal.kind === "model-routing" || proposal.kind === "dead-skill"),
      [],
      "no model-routing or dead-skill proposal may be emitted on single-project evidence",
    );
    assert.ok(report.warnings.some((warning) => /PER-PROPOSAL GUARD/u.test(warning) && warning.includes("model/a")));
    assert.ok(report.warnings.some((warning) => /PER-PROPOSAL GUARD/u.test(warning) && warning.includes("dead-skill")));
  });

  test("--out refuses a dangling symlink that points into a protected tree", (t) => {
    const root = tempDir(t, "ocw-rsi-dangling-");
    const repoConfigDir = dirname(new URL("../config/opencode.jsonc", import.meta.url).pathname);
    const protectedTarget = join(repoConfigDir, "ocw-rsi-dangling-report.json");
    assert.ok(!existsSync(protectedTarget));

    // The link target does NOT exist: a realpath-only check falls back to the link's own path and
    // passes, then the write creates the file inside the protected config directory.
    const dangling = join(root, "report-link.txt");
    symlinkSync(protectedTarget, dangling);
    assert.throws(() => writeRsiReport(dangling, "RSI report body"), /protected path/u);
    assert.throws(() => resolveSafeReportPath(dangling), /protected path/u);
    assert.ok(!existsSync(protectedTarget), "the protected target must never be created");

    // The same holds for a dangling link whose target is a not-yet-created directory chain.
    const nestedDangling = join(root, "nested-link.txt");
    symlinkSync(join(repoConfigDir, "ocw-rsi-dangling-dir", "report.txt"), nestedDangling);
    assert.throws(() => writeRsiReport(nestedDangling, "body"), /protected path/u);
    assert.ok(!existsSync(join(repoConfigDir, "ocw-rsi-dangling-dir")));

    // A dangling link that stays inside a safe directory is fine and is written at its real target.
    const safeTarget = join(root, "nested", "report.txt");
    const safeLink = join(root, "safe-link.txt");
    symlinkSync(safeTarget, safeLink);
    assert.equal(writeRsiReport(safeLink, "body"), safeTarget);
    assert.equal(readFileSync(safeTarget, "utf8"), "body\n");
    assert.equal(lstatSync(safeTarget).mode & 0o777, 0o600, "the report is written private (0o600)");
  });

  test("--out refuses protected targets, including symlinks into the live OpenCode config", (t) => {
    const root = tempDir(t, "ocw-rsi-out-");
    const repoConfigDir = join(dirname(new URL("../config/opencode.jsonc", import.meta.url).pathname), "");
    const output = "RSI report body";

    assert.throws(
      () => writeRsiReport(join("/root/.pi", "ocw-rsi-should-not-exist", "report.txt"), output),
      /protected path/u,
    );
    assert.ok(!existsSync("/root/.pi/ocw-rsi-should-not-exist"), "refusal happens before any directory is created");
    assert.throws(() => writeRsiReport(join("/root/pi-projects/pi-workflow-tools", "rsi-report.txt"), output), /protected path/u);
    assert.throws(() => writeRsiReport(join(repoConfigDir, "rsi-report.json"), output), /protected path/u);
    assert.throws(() => writeRsiReport(join(repoConfigDir, "AGENTS.md"), output), /protected path/u);

    const liveConfig = join(homedir(), ".config", "opencode");
    if (existsSync(liveConfig)) {
      const link = join(root, "opencode-link");
      symlinkSync(liveConfig, link);
      assert.throws(() => writeRsiReport(join(link, "rsi-report.txt"), output), /protected path/u, "a symlink into the live config must be refused");
      assert.ok(!existsSync(join(liveConfig, "rsi-report.txt")));
      assert.throws(() => resolveSafeReportPath(join(link, "nested", "deeper", "report.txt")), /protected path/u);
    }

    for (const forbidden of protectedReportRoots()) {
      assert.throws(() => resolveSafeReportPath(join(forbidden, "report.txt")), /protected path/u, forbidden);
    }

    const safe = writeRsiReport(join(root, "out", "report.txt"), `${output}\n\n`);
    assert.equal(readFileSync(safe, "utf8"), `${output}\n`);
  });

  test("optional LLM synthesis is read-only and failures are reported", async (t) => {
    const fixture = rsiFixture(t, { projects: ["alpha", "beta"], sessionsPerProject: 3 });
    const beforeAgents = readFileSync(fixture.agentsPath, "utf8");
    const report = await runRsiPrune({
      auditDirs: [fixture.auditDir],
      agentsPaths: [fixture.agentsPath],
      configPaths: [fixture.configPath],
      knownSkills: fixture.skills,
      withLlm: true,
      llm: async () => "Keep the used skill; no evidence supports pruning it yet.",
      now: Date.parse("2026-11-22T09:00:00Z"),
    });
    assert.match(report.synthesis, /Keep the used skill/);
    assert.equal(report.synthesisError, null);
    assert.equal(readFileSync(fixture.agentsPath, "utf8"), beforeAgents);

    const failed = await runRsiPrune({
      auditDirs: [fixture.auditDir],
      agentsPaths: [fixture.agentsPath],
      configPaths: [fixture.configPath],
      knownSkills: fixture.skills,
      withLlm: true,
      llm: async () => { throw new Error("synthesis down"); },
      now: Date.parse("2026-11-22T09:00:00Z"),
    });
    assert.equal(failed.synthesis, null);
    assert.match(failed.synthesisError, /synthesis down/);
  });
});

describe("sync-global", () => {
  function sourceRoot(t) {
    const root = tempDir(t, "ocw-sync-source-");
    mkdirSync(join(root, "config"), { recursive: true });
    writeFileSync(join(root, "config", "opencode.jsonc"), '{"new":true}\n', "utf8");
    writeFileSync(join(root, "config", "AGENTS.md"), "# New rules\n", "utf8");
    return root;
  }

  function targetWithV1(t) {
    const target = tempDir(t, "ocw-sync-target-");
    writeFileSync(join(target, "service.json"), '{"password":"exposed"}\n', "utf8");
    writeFileSync(join(target, "opencode.jsonc"), '{"old":true}\n', "utf8");
    writeFileSync(join(target, "AGENTS.md"), "# Old rules\n", "utf8");
    for (const relative of ["herdr-agent-state.js", "tui.jsonc", "herdr-tui-session.js", "package.json", "package-lock.json"]) {
      writeFileSync(join(target, relative), `${relative} legacy\n`, "utf8");
    }
    mkdirSync(join(target, "plugins"), { recursive: true });
    writeFileSync(join(target, "plugins", "herdr-agent-state.js"), "plugin legacy\n", "utf8");
    return target;
  }

  test("rotates service.json, moves v1 files aside, backs up, and copies config", (t) => {
    const source = sourceRoot(t);
    const target = targetWithV1(t);
    const result = syncGlobal({ targetDir: target, sourceRoot: source, now: Date.parse("2026-11-22T09:00:00Z") });
    assert.equal(result.changedCount > 0, true);
    assert.ok(!existsSync(join(target, "service.json")));
    assert.equal(readFileSync(join(target, "v1-disabled", "herdr-agent-state.js"), "utf8"), "herdr-agent-state.js legacy\n");
    assert.equal(readFileSync(join(target, "v1-disabled", "plugins", "herdr-agent-state.js"), "utf8"), "plugin legacy\n");
    assert.equal(readFileSync(join(target, "opencode.jsonc"), "utf8"), '{"new":true}\n');
    assert.equal(readFileSync(join(target, "AGENTS.md"), "utf8"), "# New rules\n");
    const backups = readdirSync(target).filter((name) => name.includes(".bak-"));
    assert.ok(backups.length >= 2);
    const configBackup = readdirSync(target).find((name) => name.startsWith("opencode.jsonc.bak-"));
    assert.equal(readFileSync(join(target, configBackup), "utf8"), '{"old":true}\n');
  });

  test("is idempotent on a second run", (t) => {
    const source = sourceRoot(t);
    const target = targetWithV1(t);
    syncGlobal({ targetDir: target, sourceRoot: source, now: Date.parse("2026-11-22T09:00:00Z") });
    const second = syncGlobal({ targetDir: target, sourceRoot: source, now: Date.parse("2026-11-22T10:00:00Z") });
    assert.equal(second.changedCount, 0);
    assert.equal(second.actions.length, 0);
    assert.equal(readFileSync(join(target, "opencode.jsonc"), "utf8"), '{"new":true}\n');
  });

  test("--dry-run changes nothing", (t) => {
    const source = sourceRoot(t);
    const target = targetWithV1(t);
    const result = syncGlobal({ targetDir: target, sourceRoot: source, dryRun: true });
    assert.ok(result.dryRun);
    assert.ok(result.actions.some((action) => action.type === "rotate-service"));
    assert.ok(result.actions.some((action) => action.type === "move-legacy"));
    assert.ok(result.actions.some((action) => action.type === "copy"));
    assert.ok(existsSync(join(target, "service.json")));
    assert.ok(existsSync(join(target, "herdr-agent-state.js")));
    assert.equal(readFileSync(join(target, "opencode.jsonc"), "utf8"), '{"old":true}\n');
  });

  test("--skip-service-rotate preserves the credential file", (t) => {
    const source = sourceRoot(t);
    const target = targetWithV1(t);
    syncGlobal({ targetDir: target, sourceRoot: source, skipServiceRotate: true });
    assert.ok(existsSync(join(target, "service.json")));
    assert.equal(readFileSync(join(target, "opencode.jsonc"), "utf8"), '{"new":true}\n');
  });

  test("never deletes legacy files when a destination already exists", (t) => {
    const source = sourceRoot(t);
    const target = targetWithV1(t);
    mkdirSync(join(target, "v1-disabled"), { recursive: true });
    writeFileSync(join(target, "v1-disabled", "herdr-agent-state.js"), "already here\n", "utf8");
    syncGlobal({ targetDir: target, sourceRoot: source });
    assert.equal(readFileSync(join(target, "v1-disabled", "herdr-agent-state.js"), "utf8"), "already here\n");
    assert.equal(readFileSync(join(target, "v1-disabled", "herdr-agent-state.js.1"), "utf8"), "herdr-agent-state.js legacy\n");
  });

  test("refuses to touch /root/.pi", () => {
    assert.throws(() => syncGlobal({ targetDir: "/root/.pi/something", dryRun: true }), /forbidden target/);
  });

  test("refuses pi-workflow-tools in any spelling, including through a symlink", (t) => {
    const source = sourceRoot(t);
    assert.throws(() => syncGlobal({ targetDir: "/root/pi-projects/pi-workflow-tools", sourceRoot: source, dryRun: true }), /forbidden target/);
    assert.throws(() => syncGlobal({ targetDir: "/root/pi-projects/pi-workflow-tools/config", sourceRoot: source, dryRun: true }), /forbidden target/);
    const link = join(tempDir(t, "ocw-sync-pwt-"), "pwt-link");
    symlinkSync("/root/pi-projects/pi-workflow-tools", link);
    assert.throws(() => syncGlobal({ targetDir: join(link, "deeper"), sourceRoot: source, dryRun: true }), /forbidden target/);
    assert.throws(() => syncGlobal({ targetDir: link, sourceRoot: source, dryRun: true }), /forbidden target/);
  });

  test("refuses a target directory that is a symlink into /root/.pi", (t) => {
    const source = sourceRoot(t);
    const link = join(tempDir(t, "ocw-sync-pi-link-"), "pi-link");
    symlinkSync("/root/.pi", link);
    assert.throws(() => syncGlobal({ targetDir: link, sourceRoot: source, dryRun: true }), /forbidden target/);
    assert.throws(() => syncGlobal({ targetDir: join(link, "nested", "deeper"), sourceRoot: source, dryRun: true }), /forbidden target/);
    // Nothing may be created through the link even in a real (non-dry) run.
    assert.throws(() => syncGlobal({ targetDir: link, sourceRoot: source }), /forbidden target/);
  });

  test("a planted predictable temp symlink is never opened or written through", (t) => {
    const source = sourceRoot(t);
    const target = tempDir(t, "ocw-sync-tmp-link-");
    const outside = join(tempDir(t, "ocw-sync-tmp-outside-"), "outside.jsonc");
    writeFileSync(outside, "outside\n", "utf8");
    // The previous implementation wrote to a predictable `${destination}.tmp`. Plant that exact
    // name as a symlink to a file outside the target: it must never be opened.
    const planted = join(target, "opencode.jsonc.tmp");
    symlinkSync(outside, planted);

    syncGlobal({ targetDir: target, sourceRoot: source });

    assert.equal(readFileSync(outside, "utf8"), "outside\n", "the outside file was not written through");
    assert.equal(readFileSync(join(target, "opencode.jsonc"), "utf8"), '{"new":true}\n');
    assert.ok(lstatSync(planted).isSymbolicLink(), "the planted link itself was left untouched");
    assert.deepEqual(
      readdirSync(target).filter((name) => name.startsWith(".") && name.endsWith(".tmp")),
      [],
      "random temp names leave no leftovers",
    );
    // A second run is still idempotent with the planted link present.
    assert.equal(syncGlobal({ targetDir: target, sourceRoot: source }).changedCount, 0);
  });

  test("refuses a symlink planted at the sync destination", (t) => {
    const source = sourceRoot(t);
    const target = tempDir(t, "ocw-sync-dest-link-");
    const victim = join(tempDir(t, "ocw-sync-dest-outside-"), "victim.jsonc");
    writeFileSync(victim, "victim\n", "utf8");
    symlinkSync(victim, join(target, "opencode.jsonc"));

    assert.throws(() => syncGlobal({ targetDir: target, sourceRoot: source }), /symlink outside the sync target/u);
    assert.equal(readFileSync(victim, "utf8"), "victim\n", "the link target was never written");
    assert.equal(readFileSync(join(target, "opencode.jsonc"), "utf8"), "victim\n");
    assert.ok(lstatSync(join(target, "opencode.jsonc")).isSymbolicLink());
  });

  test("refuses an in-target symlink at the sync destination without following it", (t) => {
    const source = sourceRoot(t);
    const target = tempDir(t, "ocw-sync-in-target-link-");
    const victim = join(target, "victim.json");
    writeFileSync(victim, "victim\n", "utf8");
    symlinkSync("victim.json", join(target, "opencode.jsonc"));

    // The link resolves INSIDE the target, so a resolve-first check would accept it and overwrite
    // victim.json. The destination itself must be refused as a symlink.
    assert.throws(() => syncGlobal({ targetDir: target, sourceRoot: source }), /symlink at the sync destination/u);
    assert.equal(readFileSync(victim, "utf8"), "victim\n", "the in-target referent was never overwritten");
    assert.ok(lstatSync(join(target, "opencode.jsonc")).isSymbolicLink());
    assert.deepEqual(
      readdirSync(target).filter((name) => name.includes(".bak-")),
      [],
      "no backup was taken through the link",
    );
    // A dry run is refused too, so a preview cannot advertise a write that would follow the link.
    assert.throws(() => syncGlobal({ targetDir: target, sourceRoot: source, dryRun: true }), /symlink at the sync destination/u);
  });

  test("refuses a dangling symlink into /root/.pi", (t) => {
    const source = sourceRoot(t);
    const forbidden = "/root/.pi/ocw-sync-should-not-exist";
    assert.ok(!existsSync(forbidden));

    // Dangling file symlink at a synced destination.
    const target = tempDir(t, "ocw-sync-dangling-");
    symlinkSync(`${forbidden}/opencode.jsonc`, join(target, "opencode.jsonc"));
    assert.throws(() => syncGlobal({ targetDir: target, sourceRoot: source }), /symlink outside the sync target/u);
    assert.ok(!existsSync(forbidden), "nothing was created inside /root/.pi");

    // Dangling directory symlink used as the legacy-move destination.
    const target2 = tempDir(t, "ocw-sync-dangling-dir-");
    writeFileSync(join(target2, "herdr-agent-state.js"), "legacy\n", "utf8");
    symlinkSync(forbidden, join(target2, "v1-disabled"));
    assert.throws(() => syncGlobal({ targetDir: target2, sourceRoot: source }), /symlink outside the sync target/u);
    assert.ok(!existsSync(forbidden), "nothing was created inside /root/.pi");
    assert.ok(existsSync(join(target2, "herdr-agent-state.js")), "the legacy file stayed put");

    // Dangling symlink used as the target directory itself.
    const linkDir = join(tempDir(t, "ocw-sync-dangling-root-"), "pi-link");
    symlinkSync(forbidden, linkDir);
    assert.throws(() => syncGlobal({ targetDir: linkDir, sourceRoot: source }), /forbidden target/u);
    assert.ok(!existsSync(forbidden), "nothing was created inside /root/.pi");
  });

  test("refuses to move or write through a symlink that escapes the sync target", (t) => {
    const source = sourceRoot(t);
    const target = tempDir(t, "ocw-sync-escape-");
    const outside = tempDir(t, "ocw-sync-outside-");
    writeFileSync(join(target, "herdr-agent-state.js"), "legacy\n", "utf8");
    symlinkSync(outside, join(target, "v1-disabled"));
    assert.throws(() => syncGlobal({ targetDir: target, sourceRoot: source }), /symlink outside the sync target/u);
    assert.ok(!existsSync(join(outside, "herdr-agent-state.js")), "no legacy file leaked outside the target");
    assert.ok(existsSync(join(target, "herdr-agent-state.js")), "the legacy file stayed put");
  });
});

describe("verify-setup", () => {
  test("JSONC parsing preserves URL strings and removes comments/trailing commas", () => {
    const parsed = parseJsonc('{\n// comment\n"url":"https://opencode.ai/config.json",/* block */ "list":[1,2,],\n}');
    assert.deepEqual(parsed, { url: "https://opencode.ai/config.json", list: [1, 2] });
    assert.match(stripJsonc('{"a":"// not a comment"}'), /\/\/ not a comment/);
  });

  /** The canonical config with deterministic `.env` action coverage re-declared for fixture tests. */
  function strictConfigFixture() {
    const config = parseJsonc(readFileSync(new URL("../config/opencode.jsonc", import.meta.url), "utf8"));
    const fixture = structuredClone(config);
    // Strip every `*.env.example` allow and re-declare one per file-path tool after the asks, so
    // the fixture does not depend on the canonical file's ordering details.
    fixture.permissions = fixture.permissions.filter(
      (rule) => !(rule.resource === "*.env.example" && rule.effect === "allow"),
    );
    for (const action of ENV_PROTECTED_ACTIONS) {
      fixture.permissions.push({ action, resource: "*.env", effect: "ask" });
      fixture.permissions.push({ action, resource: "*.env.*", effect: "ask" });
    }
    for (const action of FILE_ACTIONS) {
      fixture.permissions.push({ action, resource: "*.env.example", effect: "allow" });
    }
    return fixture;
  }

  test("the real repository config passes strict invariants", () => {
    const config = parseJsonc(readFileSync(new URL("../config/opencode.jsonc", import.meta.url), "utf8"));
    const result = validateConfig(config);
    assert.equal(result.ok, true, result.errors.join("; "));
    assert.ok(result.checks.some((check) => /Pinned models/u.test(check)));
    assert.ok(result.checks.some((check) => /Read-only agents/u.test(check)));
    assert.ok(result.checks.some((check) => /Bounded context\/media limits/u.test(check)));
    assert.ok(result.checks.some((check) => /\.env protection/u.test(check)));
    assert.equal(config.agents.worker.steps, undefined, "worker spin is bounded dynamically, not by a static step cap");
    for (const resource of [".env", ".env.local", "id_rsa", "server.pem", "/app/secrets/key", "/root/.config/opencode/service.json", "/root/.config/opencode/auth.json"]) {
      for (const action of FILE_ACTIONS) {
        const rule = VERIFY_INTERNALS.lastMatchingRule(config.permissions, action, resource);
        assert.equal(rule?.effect, "deny", `${action} ${resource} must resolve to deny (never stall AFK)`);
      }
    }
  });

  test("strict config validation bounds models, steps, read-only roles and context limits", () => {
    const compliant = strictConfigFixture();
    const ok = validateConfig(compliant);
    assert.equal(ok.ok, true, ok.errors.join("; "));

    const mutations = [
      ["unpinned worker model", (config) => { delete config.agents.worker.model; }, /has no pinned model id/u],
      ["non-catalog model id", (config) => { config.agents.reviewer.model = "claude-sonnet-5.5"; }, /not a pinned provider\/model id/u],
      ["zero subagent steps", (config) => { config.agents.reviewer.steps = 0; }, /Agent reviewer steps must be a finite number >= 1/u],
      ["missing required subagent steps", (config) => { delete config.agents.reviewer.steps; }, /Agent reviewer steps is missing/u],
      ["zero worker steps when explicit", (config) => { config.agents.worker.steps = 0; }, /Agent worker steps must be a finite number >= 1/u],
      ["null worker steps when explicit", (config) => { config.agents.worker.steps = null; }, /Agent worker steps is missing/u],
      ["unbounded worker steps when explicit", (config) => { config.agents.worker.steps = MAX_SUBAGENT_STEPS + 1; }, /Agent worker steps exceeds the bounded maximum/u],
      ["unbounded escalate-opus steps", (config) => { config.agents["escalate-opus"].steps = MAX_SUBAGENT_STEPS + 1; }, /Agent escalate-opus steps exceeds the bounded maximum/u],
      ["primary agent demoted", (config) => { config.agents.build.mode = "subagent"; }, /Agent build must be mode "primary"/u],
      ["writable reviewer", (config) => { config.agents.reviewer.permissions = config.agents.reviewer.permissions.filter((rule) => rule.action !== "write"); }, /Agent reviewer is read-only but write .* resolves to (allow|no rule)/u],
      ["writable planner", (config) => { config.agents.plan.permissions = undefined; }, /Agent plan is read-only but declares no permissions/u],
      ["missing compaction", (config) => { delete config.compaction; }, /compaction limits are missing/u],
      ["missing compaction keep", (config) => { delete config.compaction.keep; }, /compaction\.keep is missing/u],
      ["unbounded compaction keep", (config) => { config.compaction.keep.tokens = 5_000_000; }, /compaction\.keep\.tokens exceeds the bounded maximum/u],
      ["missing tool_output", (config) => { delete config.tool_output; }, /tool_output limits are missing/u],
      ["zero tool_output lines", (config) => { config.tool_output.max_lines = 0; }, /tool_output\.max_lines must be a finite number >= 1/u],
      ["infinite tool_output bytes", (config) => { config.tool_output.max_bytes = Number.POSITIVE_INFINITY; }, /tool_output\.max_bytes must be a finite number/u],
      ["missing media limits", (config) => { delete config.media; }, /media\.image limits are missing/u],
      ["NaN media dimension", (config) => { config.media.image.max_height = Number.NaN; }, /media\.image\.max_height must be a finite number/u],
      ["unbounded media payload", (config) => { config.media.image.max_base64_bytes = 9 * 1024 * 1024; }, /media\.image\.max_base64_bytes exceeds the bounded maximum/u],
    ];
    for (const [label, mutate, pattern] of mutations) {
      const broken = structuredClone(compliant);
      mutate(broken);
      const result = validateConfig(broken);
      assert.equal(result.ok, false, label);
      assert.ok(result.errors.some((error) => pattern.test(error)), `${label}: ${result.errors.join("; ")}`);
    }

    // Omitting `worker.steps` is the intended shape: reactive-guard.js bounds spin dynamically.
    const omitted = structuredClone(compliant);
    delete omitted.agents.worker.steps;
    const omittedResult = validateConfig(omitted);
    assert.equal(omittedResult.ok, true, omittedResult.errors.join("; "));
    assert.deepEqual(OPTIONAL_STEPS_SUBAGENTS, ["worker"]);

    assert.deepEqual(READ_ONLY_AGENTS, ["reviewer", "fact-checker", "alt-reviewer", "plan"]);
    assert.deepEqual(WRITE_ACTIONS, ["edit", "write", "patch"]);
  });

  test("strict config validation protects .env for read/edit/write/patch/shell/bash and allows .env.example", () => {
    const compliant = strictConfigFixture();
    assert.equal(validateConfig(compliant).ok, true);

    for (const action of ENV_PROTECTED_ACTIONS) {
      const broken = structuredClone(compliant);
      broken.permissions = broken.permissions.filter((rule) => !(rule.action === action && (rule.effect === "ask" || rule.effect === "deny")));
      const result = validateConfig(broken);
      assert.equal(result.ok, false, action);
      assert.ok(
        result.errors.some((error) => /\.env protection is incomplete/u.test(error) && error.includes(action)),
        `${action}: ${result.errors.join("; ")}`,
      );
    }

    const exampleBlocked = structuredClone(compliant);
    exampleBlocked.permissions = exampleBlocked.permissions.map((rule) =>
      rule.action === "read" && rule.resource === "*.env.example" ? { ...rule, effect: "ask" } : rule,
    );
    assert.ok(
      validateConfig(exampleBlocked).errors.some((error) => /\.env\.example must be explicitly allowed/u.test(error)),
      "the documentation sample must stay readable",
    );
  });

  test("rejects a model id that is outside the approved OCW-03 catalog", () => {
    const compliant = strictConfigFixture();
    assert.equal(validateConfig(compliant).ok, true);

    // Shape-valid but not in the approved lineup: a regex-only check would accept this.
    const arbitrary = structuredClone(compliant);
    arbitrary.agents.reviewer.model = "not-a-catalog/model";
    const arbitraryResult = validateConfig(arbitrary);
    assert.equal(arbitraryResult.ok, false);
    assert.ok(
      arbitraryResult.errors.some(
        (error) => /not in the approved OCW-03 model catalog/u.test(error) && error.includes("not-a-catalog/model"),
      ),
      arbitraryResult.errors.join("; "),
    );

    // Every configured agent is held to the catalog, not just the eight required ones.
    const extraAgent = structuredClone(compliant);
    extraAgent.agents.helper = { mode: "subagent", model: "not-a-catalog/model" };
    assert.ok(
      validateConfig(extraAgent).errors.some((error) => /Agent helper model "not-a-catalog\/model" is not in the approved OCW-03 model catalog/u.test(error)),
    );

    // The top-level default model drives every unpinned agent, so it is held to the catalog too.
    const topLevel = structuredClone(compliant);
    topLevel.model = "not-a-catalog/model";
    assert.ok(
      validateConfig(topLevel).errors.some((error) => /Config model "not-a-catalog\/model" is not in the approved OCW-03 model catalog/u.test(error)),
    );

    // Approved ids pass with their routing prefix and reasoning variant; nothing else does.
    assert.equal(isApprovedModel("openrouter/google/gemini-4-neon#high"), true);
    assert.equal(isApprovedModel("deepseek/deepseek-v4.1-flash-1017"), true);
    assert.equal(isApprovedModel("openrouter/openai/gpt-6-luna"), true);
    assert.equal(isApprovedModel("not-a-catalog/model"), false);
    assert.equal(isApprovedModel("openrouter/not-a-catalog/model#high"), false);
    assert.ok(APPROVED_MODELS.length >= 6, "the allowlist is an explicit catalog, not a shape test");
    for (const model of APPROVED_MODELS) assert.equal(isApprovedModel(model), true, model);
  });

  /**
   * The exact `opencode --standalone debug config` shape OpenCode 2.3.2 prints (verified live in
   * Wave 7A): an array of layered entries, where only `type: "document"` carries `info` and the
   * resolved default model is the normalized object `{ providerID, model, variant }`.
   */
  function realResolvedConfigFixture() {
    return [
      {
        type: "document",
        path: "/root/.config/opencode/opencode.jsonc",
        info: {
          $schema: "https://opencode.ai/config.json",
          model: { providerID: "openrouter", model: "google/gemini-4-neon", variant: "high" },
          default_agent: "build",
          permissions: [{ action: "*", resource: "*", effect: "allow" }],
          agents: { build: { mode: "primary", model: "openrouter/google/gemini-4-neon#high", steps: 40 } },
          media: { image: { maxDimension: 4096, maxBase64Bytes: 8 * 1024 * 1024 } },
          tool_output: { maxLines: 4000, maxBytes: 1_048_576 },
          mcp: {
            servers: {
              pi_search: {
                type: "local",
                command: ["/root/pi-projects/pi-search/bin/pi-search", "mcp"],
                cwd: "/root/pi-projects/pi-search",
                codemode: true,
              },
            },
          },
          compaction: { keepTokens: 120_000 },
          plugins: ["/root/pi-projects/opencode-workflow/plugins/audit-logger"],
        },
      },
      { type: "directory", path: "/root/.config/opencode", info: {} },
      { type: "directory", path: "/root/.opencode", info: {} },
    ];
  }

  test("resolved debug config accepts the real 2.3.2 array-of-documents shape", () => {
    const real = realResolvedConfigFixture();
    const result = validateResolvedConfig(real);
    assert.equal(result.ok, true, result.errors.join("; "));

    // The array is unwrapped to the merged `document` info (directory entries contribute nothing).
    const unwrapped = VERIFY_INTERNALS.unwrapResolvedConfig(real);
    assert.equal(unwrapped.ok, true);
    assert.deepEqual(unwrapped.config.model, {
      providerID: "openrouter",
      model: "google/gemini-4-neon",
      variant: "high",
    });
    assert.equal(unwrapped.config.default_agent, "build");
    assert.equal(Object.keys(unwrapped.config).length, 10, "every document key survives the unwrap");

    // String and normalized-object model spellings normalize to the same catalog id.
    assert.equal(VERIFY_INTERNALS.resolvedModelId(unwrapped.config.model), "openrouter/google/gemini-4-neon#high");
    assert.equal(VERIFY_INTERNALS.resolvedModelId("openrouter/google/gemini-4-neon#high"), "openrouter/google/gemini-4-neon#high");
    assert.equal(VERIFY_INTERNALS.resolvedModelId({ providerID: "openrouter", model: "google/gemini-4-neon" }), "openrouter/google/gemini-4-neon");
    // A model object with no variant still resolves, and an incomplete one never does.
    const noVariant = realResolvedConfigFixture();
    noVariant[0].info.model = { providerID: "openrouter", model: "google/gemini-4-neon" };
    assert.equal(validateResolvedConfig(noVariant).ok, true, validateResolvedConfig(noVariant).errors.join("; "));
    assert.equal(VERIFY_INTERNALS.resolvedModelId({ providerID: "openrouter" }), null);
    assert.equal(VERIFY_INTERNALS.resolvedModelId({}), null);

    // Later documents win per top-level key, and a config object is passed through unchanged.
    const layered = [
      { type: "document", path: "/a.jsonc", info: { model: { providerID: "openrouter", model: "google/gemini-4-neon" }, plugins: ["/p/audit-logger"] } },
      { type: "directory", path: "/a", info: {} },
      { type: "document", path: "/b.jsonc", info: { model: { providerID: "openrouter", model: "openai/gpt-6-luna" } } },
    ];
    const layeredResult = VERIFY_INTERNALS.unwrapResolvedConfig(layered);
    assert.equal(layeredResult.ok, true);
    assert.deepEqual(layeredResult.config.model, { providerID: "openrouter", model: "openai/gpt-6-luna" });
    assert.deepEqual(layeredResult.config.plugins, ["/p/audit-logger"], "earlier keys survive a partial later document");
  });

  test("resolved debug config rejects document-less and unapproved resolved shapes", () => {
    // Parses as JSON but resolves no config at all: nothing to unwrap.
    for (const [label, shape] of [
      ["empty array", []],
      ["directory entries only", [{ type: "directory", path: "/root/.config/opencode", info: {} }]],
      ["null", null],
    ]) {
      const result = validateResolvedConfig(shape);
      assert.equal(result.ok, false, `${label} must be rejected`);
      assert.ok(
        result.errors.some((error) => /debug config did not resolve to a JSON object/u.test(error)),
        `${label}: ${result.errors.join("; ")}`,
      );
    }

    // `{}` is an object, so it is unwrapped and then fails each required-field check.
    const emptyObject = validateResolvedConfig({});
    assert.equal(emptyObject.ok, false);
    assert.ok(emptyObject.errors.some((error) => /debug config resolved no model/u.test(error)));
    assert.ok(emptyObject.errors.some((error) => /debug config resolved no mcp\.servers\.pi_search server/u.test(error)));
    assert.ok(emptyObject.errors.some((error) => /debug config resolved no audit-logger plugin/u.test(error)));

    // The array shape is unwrapped, so each required field is still enforced individually.
    const missingModel = realResolvedConfigFixture();
    delete missingModel[0].info.model;
    assert.ok(validateResolvedConfig(missingModel).errors.some((error) => /debug config resolved no model/u.test(error)));

    const missingPiSearch = realResolvedConfigFixture();
    delete missingPiSearch[0].info.mcp;
    assert.ok(
      validateResolvedConfig(missingPiSearch).errors.some((error) => /debug config resolved no mcp\.servers\.pi_search server/u.test(error)),
    );

    const missingAudit = realResolvedConfigFixture();
    missingAudit[0].info.plugins = ["/some/other/plugin"];
    assert.ok(validateResolvedConfig(missingAudit).errors.some((error) => /debug config resolved no audit-logger plugin/u.test(error)));

    // A normalized model object is held to the OCW-03 catalog, not merely to a provider/model shape.
    const unapproved = realResolvedConfigFixture();
    unapproved[0].info.model = { providerID: "openrouter", model: "not-a-catalog/model", variant: "high" };
    const unapprovedResult = validateResolvedConfig(unapproved);
    assert.equal(unapprovedResult.ok, false);
    assert.ok(
      unapprovedResult.errors.some(
        (error) => /debug config resolved model "openrouter\/not-a-catalog\/model#high" is not in the approved OCW-03 model catalog/u.test(error),
      ),
      unapprovedResult.errors.join("; "),
    );

    const unapprovedString = realResolvedConfigFixture();
    unapprovedString[0].info.model = "openrouter/not-a-catalog/model#high";
    assert.equal(validateResolvedConfig(unapprovedString).ok, false);

    // pi_search must stay a local codemode server.
    const remote = realResolvedConfigFixture();
    remote[0].info.mcp.servers.pi_search.type = "remote";
    assert.ok(
      validateResolvedConfig(remote).errors.some((error) => /mcp\.servers\.pi_search\.type "remote" instead of "local"/u.test(error)),
    );

    const codemodeOff = realResolvedConfigFixture();
    codemodeOff[0].info.mcp.servers.pi_search.codemode = false;
    assert.equal(validateResolvedConfig(codemodeOff).ok, false);
    assert.ok(validateResolvedConfig(codemodeOff).errors.some((error) => /codemode false/u.test(error)));

    // `codemode` merely absent is still accepted: only an explicit disable fails closed.
    const codemodeAbsent = realResolvedConfigFixture();
    delete codemodeAbsent[0].info.mcp.servers.pi_search.codemode;
    assert.equal(validateResolvedConfig(codemodeAbsent).ok, true, validateResolvedConfig(codemodeAbsent).errors.join("; "));
  });

  test("a non-document entry carrying info is never merged as resolved config", () => {
    const directoryOnly = [
      {
        type: "directory",
        path: "/tmp/x",
        info: {
          model: "openrouter/google/gemini-4-neon#high",
          mcp: { servers: { pi_search: { type: "local", codemode: true } } },
          plugins: ["/x/audit-logger"],
        },
      },
    ];
    const unwrapped = VERIFY_INTERNALS.unwrapResolvedConfig(directoryOnly);
    assert.equal(unwrapped.ok, false, "a directory entry is metadata, not config");
    assert.ok(unwrapped.errors.some((error) => /debug config did not resolve to a JSON object/u.test(error)));

    const result = validateResolvedConfig(directoryOnly);
    assert.equal(result.ok, false, "a fully-populated directory entry must not pass verification");
    assert.ok(result.errors.some((error) => /debug config did not resolve to a JSON object/u.test(error)));

    // A document entry in the same array still resolves, and the directory's info is ignored.
    const mixed = [
      {
        type: "document",
        path: "/tmp/x.jsonc",
        info: {
          model: "openrouter/google/gemini-4-neon#high",
          mcp: { servers: { pi_search: { type: "local" } } },
          plugins: ["/x/audit-logger"],
        },
      },
      ...directoryOnly,
    ];
    const mixedResult = VERIFY_INTERNALS.unwrapResolvedConfig(mixed);
    assert.equal(mixedResult.ok, true);
    assert.deepEqual(Object.keys(mixedResult.config).sort(), ["mcp", "model", "plugins"]);
    const mixedValidated = validateResolvedConfig(mixed);
    assert.equal(mixedValidated.ok, true, mixedValidated.errors.join("; "));
  });

  test("resolved debug config must prove a model, pi_search and the audit plugin", () => {
    assert.equal(VERIFY_INTERNALS.normalizeModelId("openrouter/google/gemini-4-neon#high"), "google/gemini-4-neon");
    // `{}` is valid JSON: parsing alone proves nothing about what the binary resolved.
    const empty = validateResolvedConfig({});
    assert.equal(empty.ok, false);
    assert.ok(empty.errors.some((error) => /debug config resolved no model/u.test(error)));
    assert.ok(empty.errors.some((error) => /pi_search/u.test(error)));
    assert.ok(empty.errors.some((error) => /audit-logger/u.test(error)));
    assert.equal(validateResolvedConfig(null).ok, false);

    const good = validateResolvedConfig({
      model: "openrouter/google/gemini-4-neon#high",
      mcp: { servers: { pi_search: { type: "local", command: ["pi-search", "mcp"] } } },
      plugins: ["/root/pi-projects/opencode-workflow/plugins/audit-logger"],
    });
    assert.equal(good.ok, true, good.errors.join("; "));

    const withoutAudit = validateResolvedConfig({
      model: "openrouter/google/gemini-4-neon#high",
      mcp: { servers: { pi_search: { type: "local" } } },
      plugins: ["/some/other/plugin"],
    });
    assert.equal(withoutAudit.ok, false);
    assert.ok(withoutAudit.errors.some((error) => /audit-logger/u.test(error)));

    // A resolved model outside the approved catalog is rejected on the object shape too.
    const unapproved = validateResolvedConfig({
      model: "not-a-catalog/model",
      mcp: { servers: { pi_search: { type: "local" } } },
      plugins: ["audit-logger"],
    });
    assert.equal(unapproved.ok, false);
    assert.ok(unapproved.errors.some((error) => /not in the approved OCW-03 model catalog/u.test(error)));
  });

  test("rejects a *.env.example shell/bash bypass and requires the sample allow on all four file tools", () => {
    const compliant = strictConfigFixture();
    assert.equal(validateConfig(compliant).ok, true);

    // A trailing `*.env.example` allow on a shell action is a bypass: its resource is the whole
    // command line, so `cat .env # .env.example` would match and read the real `.env`.
    const bypass = structuredClone(compliant);
    for (const action of SHELL_ACTIONS) bypass.permissions.push({ action, resource: "*.env.example", effect: "allow" });
    const bypassResult = validateConfig(bypass);
    assert.equal(bypassResult.ok, false);
    for (const action of SHELL_ACTIONS) {
      for (const command of ENV_SAMPLE_BYPASS_COMMANDS) {
        assert.ok(
          bypassResult.errors.some((error) => error.includes(`permission ordering: ${action} "${command}"`)),
          `${action} "${command}": ${bypassResult.errors.join("; ")}`,
        );
      }
    }

    // Every file-path tool must keep the documentation sample allowed.
    for (const action of FILE_ACTIONS) {
      const broken = structuredClone(compliant);
      broken.permissions = broken.permissions.filter(
        (rule) => !(rule.action === action && rule.resource === "*.env.example" && rule.effect === "allow"),
      );
      const errors = validateConfig(broken).errors;
      assert.ok(
        errors.some((error) => error.includes(`permission ordering: ${action} .env.example must be explicitly allowed`)),
        `${action}: ${errors.join("; ")}`,
      );
    }

    // Sanity: the canonical config itself resolves both bypass commands to ask on shell and bash.
    const canonical = parseJsonc(readFileSync(new URL("../config/opencode.jsonc", import.meta.url), "utf8"));
    for (const action of SHELL_ACTIONS) {
      for (const command of ENV_SAMPLE_BYPASS_COMMANDS) {
        const rule = VERIFY_INTERNALS.lastMatchingRule(canonical.permissions, action, command);
        assert.equal(rule?.effect, "ask", `${action} "${command}" must ask`);
      }
    }
  });

  test("detects Terra, missing agents, disabled codemode, and bad permission order", () => {
    const bad = {
      $schema: "https://opencode.ai/config.json",
      agents: { build: { model: "openai/gpt-6.1-terra-pro" } },
      mcp: { servers: { pi_search: { type: "local", command: ["x"], codemode: false } } },
      permissions: [
        { action: "read", resource: "*.env", effect: "ask" },
        { action: "*", resource: "*", effect: "allow" },
      ],
    };
    const result = validateConfig(bad);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => /Terra/.test(error)));
    assert.ok(result.errors.some((error) => /Missing required agent/.test(error)));
    assert.ok(result.errors.some((error) => /codemode/.test(error)));
    assert.ok(result.errors.some((error) => /baseline allow rule must be first/.test(error)));
    assert.ok(result.errors.some((error) => /permission ordering/.test(error)));
  });

  test("AGENTS.md enforces 2,800 target and 3,000 hard ceilings", (t) => {
    const dir = tempDir(t);
    const near = join(dir, "near.md");
    writeFileSync(near, "x".repeat(2850), "utf8");
    const nearResult = validateAgentsFile(near);
    assert.equal(nearResult.ok, true);
    assert.ok(nearResult.warnings.some((warning) => /target/.test(warning)));
    const huge = join(dir, "huge.md");
    writeFileSync(huge, "x".repeat(3100), "utf8");
    const hugeResult = validateAgentsFile(huge);
    assert.equal(hugeResult.ok, false);
    assert.ok(hugeResult.errors.some((error) => /hard ceiling/.test(error)));
  });

  test("plugin log inspection only fails on this workflow's audit plugin", () => {
    const log = [
      'message="failed to load plugin" target=/root/pi-projects/opencode-workflow/plugins/audit-logger',
      'message="failed to load plugin" target=/some/other/plugin',
      'message="failed to load plugin" target=opencode-workflow-audit',
    ].join("\n");
    const result = inspectPluginLoadLog(log);
    assert.equal(result.count, 2);
    assert.equal(result.ok, false);
    assert.equal(inspectPluginLoadLog('message="loaded plugin" target=opencode-workflow-audit').ok, true);
  });

  test("resolveAuditDir mirrors the plugin default and honours the env override", () => {
    assert.equal(resolveAuditDir({ XDG_DATA_HOME: "/data" }), "/data/opencode-workflow/audit");
    assert.equal(resolveAuditDir({ OPENCODE_WORKFLOW_AUDIT_DIR: "/custom/audit" }), "/custom/audit");
    assert.match(resolveAuditDir({}), /opencode-workflow\/audit$/);
  });

  test("audit evidence requires a plugin.loaded record and rejects a disabled logger", (t) => {
    const dir = tempDir(t, "ocw-audit-evidence-");
    assert.equal(inspectAuditEvidence(dir).ok, false);
    assert.equal(inspectAuditEvidence(join(dir, "missing")).ok, false);

    const file = join(dir, "2026-11-22.jsonl");
    writeFileSync(file, `${JSON.stringify({ ts: "2026-11-22T09:00:00.000Z", v: 1, event: "tool.before", tool: "read" })}\nnot json\n`, "utf8");
    const missing = inspectAuditEvidence(dir);
    assert.equal(missing.ok, false);
    assert.equal(missing.records, 1, "malformed lines are skipped");
    assert.ok(missing.warnings.some((warning) => /plugin.loaded/.test(warning)));

    writeFileSync(file, [
      { ts: "2026-11-22T08:00:00.000Z", v: 1, event: "plugin.loaded", plugin: AUDIT_PLUGIN_ID, loggingEnabled: false, loggingDisabledReason: "EACCES" },
      { ts: "2026-11-22T09:00:00.000Z", v: 1, event: "plugin.loaded", plugin: AUDIT_PLUGIN_ID, loggingEnabled: true },
    ].map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
    const disabled = inspectAuditEvidence(dir);
    assert.equal(disabled.pluginLoaded, 1, "only the enabled load is proven evidence");
    assert.equal(disabled.ok, false);
    assert.ok(disabled.errors.some((error) => /disabled at runtime/.test(error)));

    writeFileSync(
      file,
      `${JSON.stringify({ ts: "2026-11-22T09:00:00.000Z", v: 1, event: "plugin.loaded", plugin: AUDIT_PLUGIN_ID, loggingEnabled: true })}\n`,
      "utf8",
    );
    assert.equal(inspectAuditEvidence(dir).ok, true);

    // A bare `{"event":"plugin.loaded"}` proves nothing: it names no plugin and no logging state.
    writeFileSync(file, `${JSON.stringify({ event: "plugin.loaded" })}\n`, "utf8");
    const bare = inspectAuditEvidence(dir);
    assert.equal(bare.ok, false, "a bare plugin.loaded record must not be accepted as evidence");
    assert.equal(bare.pluginLoaded, 0);
    assert.ok(bare.rejectedLoads.length >= 1);
    assert.ok(bare.errors.some((error) => /plugin id null is not opencode-workflow-audit/u.test(error)));

    // A foreign plugin id is not this workflow's audit plugin either.
    writeFileSync(file, `${JSON.stringify({ event: "plugin.loaded", plugin: "some-other-plugin", loggingEnabled: true })}\n`, "utf8");
    const foreign = inspectAuditEvidence(dir);
    assert.equal(foreign.ok, false);
    assert.equal(foreign.pluginLoaded, 0);
    assert.ok(foreign.errors.some((error) => /some-other-plugin/u.test(error)));

    // `loggingEnabled` must be exactly true, not merely present.
    writeFileSync(file, `${JSON.stringify({ event: "plugin.loaded", plugin: AUDIT_PLUGIN_ID })}\n`, "utf8");
    const unflagged = inspectAuditEvidence(dir);
    assert.equal(unflagged.ok, false);
    assert.ok(unflagged.errors.some((error) => /loggingEnabled is null, not true/u.test(error)));
  });

  test("offline verify passes for the canonical config", async () => {
    const good = await verifySetup({ binary: false });
    assert.equal(good.ok, true, good.errors.join("; "));
    assert.ok(good.checks.some((check) => check.startsWith("JSONC parse")));
    assert.ok(good.warnings.some((warning) => /binary checks skipped/.test(warning)));
  });

  test("offline verify fails for a bad config", async (t) => {
    const dir = tempDir(t);
    const badConfig = join(dir, "opencode.jsonc");
    writeFileSync(badConfig, '{"agents":{},"mcp":{"servers":{}},"permissions":[]}', "utf8");
    const badAgents = join(dir, "AGENTS.md");
    writeFileSync(badAgents, "x".repeat(3100), "utf8");
    const bad = await verifySetup({ configPath: badConfig, agentsPath: badAgents, binary: false });
    assert.equal(bad.ok, false);
    assert.ok(bad.errors.some((error) => /pi_search/.test(error)));
    assert.ok(bad.errors.some((error) => /Missing required agent/.test(error)));
    assert.ok(bad.errors.some((error) => /hard ceiling/.test(error)));
    assert.ok(bad.errors.some((error) => /permissions must be a non-empty ordered array/.test(error)));
  });

  /**
   * Executable stand-in for the OpenCode binary. It answers the three `--standalone` checks and can
   * optionally write an OpenCode log line and/or a `plugin.loaded` audit record, so the plugin-load
   * contract can be exercised offline without running the real binary.
   */
  const RESOLVED_CONFIG = Object.freeze({
    model: "openrouter/google/gemini-4-neon#high",
    mcp: { servers: { pi_search: { type: "local", command: ["pi-search", "mcp"], codemode: true } } },
    plugins: ["/root/pi-projects/opencode-workflow/plugins/audit-logger"],
  });

  function stubOpencodeBin(t, { writeLog = true, writeAudit = true, resolvedConfig = RESOLVED_CONFIG } = {}) {
    const dir = tempDir(t, "ocw-stub-bin-");
    const bin = join(dir, "opencode-stub");
    const agents = JSON.stringify(
      ["build", "plan", "worker", "reviewer", "fact-checker", "escalate-opus", "escalate-fable", "alt-reviewer"]
        .map((id) => ({ id })),
    );
    const resolved = JSON.stringify(resolvedConfig);
    const script = [
      "#!/bin/sh",
      'case "$3" in',
      `  config) echo '${resolved}' ;;`,
      `  agents) echo '${agents}' ;;`,
      `  list) echo 'pi_search 4 tools' ;;`,
      "esac",
      writeLog
        ? 'mkdir -p "$XDG_DATA_HOME/opencode/log" && echo \'message="loaded plugin" target=opencode-workflow-audit\' >> "$XDG_DATA_HOME/opencode/log/app.log"'
        : ":",
      writeAudit
        ? `mkdir -p "$OPENCODE_WORKFLOW_AUDIT_DIR" && echo '{"ts":"2026-11-22T09:00:00.000Z","v":1,"event":"plugin.loaded","plugin":"${AUDIT_PLUGIN_ID}","loggingEnabled":true}' > "$OPENCODE_WORKFLOW_AUDIT_DIR/2026-11-22.jsonl"`
        : ":",
      "exit 0",
      "",
    ].join("\n");
    writeFileSync(bin, script, { mode: 0o755 });
    return bin;
  }

  test("binary runs fail when the OpenCode log or plugin.loaded evidence is missing", (t) => {
    const missingLog = runBinaryChecks({ opencodeBin: stubOpencodeBin(t, { writeLog: false }) });
    assert.equal(missingLog.ok, false);
    assert.ok(missingLog.errors.some((error) => /No OpenCode log was found/u.test(error)), "a missing log is an error");

    const missingEvidence = runBinaryChecks({ opencodeBin: stubOpencodeBin(t, { writeAudit: false }) });
    assert.equal(missingEvidence.ok, false);
    assert.ok(
      missingEvidence.errors.some((error) => /No plugin.loaded record was written to the isolated audit directory/u.test(error)),
      "a missing plugin.loaded record is an error",
    );
    assert.ok(!missingEvidence.errors.some((error) => /No OpenCode log was found/u.test(error)));

    const healthy = runBinaryChecks({ opencodeBin: stubOpencodeBin(t) });
    assert.equal(healthy.ok, true, healthy.errors.join("; "));
    assert.equal(healthy.auditEvidence.pluginLoaded, 1);
    assert.ok(healthy.auditDir.startsWith(tmpdir()), "audit evidence comes from a fresh temp directory");
    assert.match(healthy.auditDir, /opencode-verify-/u);
  });

  test("binary runs reject an empty resolved debug config", (t) => {
    const result = runBinaryChecks({ opencodeBin: stubOpencodeBin(t, { resolvedConfig: {} }) });
    assert.equal(result.ok, false, "`{}` is valid JSON but proves nothing was resolved");
    assert.ok(result.errors.some((error) => /debug config resolved no model/u.test(error)));
    assert.ok(result.errors.some((error) => /debug config resolved no mcp\.servers\.pi_search server/u.test(error)));
    assert.ok(result.errors.some((error) => /debug config resolved no audit-logger plugin/u.test(error)));
    // The healthy stub still passes all three resolved-config checks.
    const healthy = runBinaryChecks({ opencodeBin: stubOpencodeBin(t) });
    assert.equal(healthy.ok, true, healthy.errors.join("; "));
  });

  test("binary runs accept the real 2.3.2 array-shaped debug config end to end", (t) => {
    const result = runBinaryChecks({ opencodeBin: stubOpencodeBin(t, { resolvedConfig: realResolvedConfigFixture() }) });
    assert.equal(result.ok, true, result.errors.join("; "));
    assert.equal(result.auditEvidence.pluginLoaded, 1);

    // Same array shape, but only directory entries: nothing was resolved, so the run fails.
    const documentless = runBinaryChecks({
      opencodeBin: stubOpencodeBin(t, { resolvedConfig: [{ type: "directory", path: "/root/.config/opencode", info: {} }] }),
    });
    assert.equal(documentless.ok, false);
    assert.ok(
      documentless.errors.some((error) => /debug config did not resolve to a JSON object/u.test(error)),
      documentless.errors.join("; "),
    );
  });

  test("binary runs never accept historical plugin.loaded evidence", (t) => {
    const historical = tempDir(t, "ocw-historical-audit-");
    writeFileSync(
      join(historical, "2026-11-01.jsonl"),
      `${JSON.stringify({ ts: "2026-11-01T08:00:00.000Z", v: 1, event: "plugin.loaded", loggingEnabled: true })}\n`,
      "utf8",
    );
    const previous = process.env.OPENCODE_WORKFLOW_AUDIT_DIR;
    process.env.OPENCODE_WORKFLOW_AUDIT_DIR = historical;
    try {
      const result = runBinaryChecks({ opencodeBin: stubOpencodeBin(t, { writeAudit: false }), auditDir: historical });
      assert.equal(result.ok, false, "an old plugin.loaded record must not satisfy a fresh run");
      assert.notEqual(result.auditDir, historical);
      assert.ok(!result.auditDir.startsWith(historical));
      assert.equal(result.auditEvidence.pluginLoaded, 0);
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_WORKFLOW_AUDIT_DIR;
      else process.env.OPENCODE_WORKFLOW_AUDIT_DIR = previous;
    }
  });

  test("offline verify accepts a fully compliant fixture and rejects a lost .env action", async (t) => {
    const dir = tempDir(t, "ocw-verify-fixture-");
    const agentsPath = join(dir, "AGENTS.md");
    writeFileSync(agentsPath, "# rules\n", "utf8");

    const goodConfig = join(dir, "good.jsonc");
    writeFileSync(goodConfig, JSON.stringify(strictConfigFixture(), null, 2), "utf8");
    const good = await verifySetup({ configPath: goodConfig, agentsPath, binary: false });
    assert.equal(good.ok, true, good.errors.join("; "));
    assert.ok(good.checks.some((check) => /\.env protection: pass/u.test(check)));
    assert.ok(good.checks.some((check) => /Read-only agents: pass/u.test(check)));

    const brokenFixture = strictConfigFixture();
    brokenFixture.permissions = brokenFixture.permissions.filter((rule) => !(rule.action === "bash" && rule.effect === "ask"));
    const brokenConfig = join(dir, "broken.jsonc");
    writeFileSync(brokenConfig, JSON.stringify(brokenFixture, null, 2), "utf8");
    const broken = await verifySetup({ configPath: brokenConfig, agentsPath, binary: false });
    assert.equal(broken.ok, false);
    assert.ok(broken.errors.some((error) => /\.env protection is incomplete/u.test(error) && error.includes("bash")));
  });
});

describe("audit JSONL (Wave 2B) -> analysis (Wave 2C) integration", () => {
  /**
   * Minimal stand-in for the @opencode/plugin context the audit logger registers against.
   * Same contract as test/audit-logger.test.mjs, kept local so this file stays self-contained.
   */
  function auditContext({ directory, events = [] }) {
    const callbacks = new Map();
    const domain = (name) => ({
      async hook(hookName, callback) {
        const key = `${name}.${hookName}`;
        callbacks.set(key, callback);
        return {
          key,
          async dispose() {
            callbacks.delete(key);
          },
        };
      },
    });
    const ctx = {
      app: { name: "cli", version: "2.3.2" },
      location: { directory },
      options: {},
      session: domain("session"),
      tool: domain("tool"),
      permission: domain("permission"),
      shell: domain("shell"),
      event: {
        subscribe({ signal } = {}) {
          return (async function* scriptedEvents() {
            for (const event of events) {
              if (signal?.aborted) return;
              yield event;
              await new Promise((resolve) => setImmediate(resolve));
            }
            if (!signal) return;
            await new Promise((resolve) => {
              if (signal.aborted) return resolve();
              signal.addEventListener("abort", resolve, { once: true });
            });
          })();
        },
      },
    };
    return { ctx, callbacks };
  }

  /** Boots the real plugin against a mocked host, drives hooks, and waits for the JSONL to land. */
  async function runAuditPlugin({ auditDir, directory, events = [], hooks = [] }) {
    const previous = process.env.OPENCODE_WORKFLOW_AUDIT_DIR;
    process.env.OPENCODE_WORKFLOW_AUDIT_DIR = auditDir;
    try {
      const before = allAuditRecords(auditDir).length;
      const mock = auditContext({ directory, events });
      const cleanup = await auditPlugin.setup(mock.ctx);
      for (const [hook, input] of hooks) {
        const callback = mock.callbacks.get(hook);
        assert.ok(callback, `hook ${hook} was not registered by the plugin`);
        await callback(input);
      }
      if (events.length) {
        const expected = before + hooks.length + events.length + 1; // + plugin.loaded
        await waitFor(() => allAuditRecords(auditDir).length >= expected, {
          message: `audit log did not reach ${expected} records (event subscriber stalled)`,
        });
      }
      await cleanup();
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_WORKFLOW_AUDIT_DIR;
      else process.env.OPENCODE_WORKFLOW_AUDIT_DIR = previous;
    }
  }

  // "git push origin main" is a realistic destructive command the config asks about; spelling it
  // once keeps the assertions below readable.
  const PUSH = "git push origin main";

  test("both analysers parse real plugin records (calls, errors, permissions, shells, usage)", async (t) => {
    const root = tempDir(t, "ocw-integration-");
    const alpha = join(root, "alpha");
    const beta = join(root, "beta");
    mkdirSync(alpha, { recursive: true });
    mkdirSync(beta, { recursive: true });
    const auditDir = join(root, "audit");
    const now = Date.now();

    const readCall = (session, callId, filePath) => [
      ["tool.execute.before", { tool: "read", id: callId, sessionID: session, agent: "build", messageID: `${callId}-msg`, input: { filePath } }],
      ["tool.execute.after", { tool: "read", id: callId, sessionID: session, agent: "build", messageID: `${callId}-msg`, status: "completed", input: { filePath }, result: { output: "contents" } }],
    ];
    const failedBash = (session, callId, command) => [
      ["tool.execute.before", { tool: "bash", id: callId, sessionID: session, agent: "build", messageID: `${callId}-msg`, input: { command } }],
      ["tool.execute.after", { tool: "bash", id: callId, sessionID: session, agent: "build", messageID: `${callId}-msg`, status: "error", input: { command }, error: new Error("exit 1") }],
    ];

    const alphaHooks = [
      ...readCall("ses_a1", "call_a1_read", join(alpha, "main.mjs")),
      ...failedBash("ses_a1", "call_a1_test1", "npm test"),
      ...failedBash("ses_a1", "call_a1_test2", "npm test"),
      ["permission.evaluate", {
        sessionID: "ses_a1",
        agent: "build",
        action: "bash",
        resources: [PUSH],
        effect: "deny",
        source: { type: "tool", id: "call_a1_test1", messageID: "call_a1_test1-msg" },
        message: "needs approval",
      }],
      ["session.prompt", {
        sessionID: "ses_a1",
        messageID: "msg_a1",
        delivery: "queue",
        prompt: { text: "Ship the bounded feature", files: [] },
      }],
      ["shell.create.before", { command: "ls -la", cwd: alpha, timeout: 1000, shell: "/bin/bash", env: { PATH: "/usr/bin" } }],
      ...readCall("ses_a2", "call_a2_read", join(alpha, "worker.mjs")),
      ...readCall("ses_a3", "call_a3_read", join(alpha, "review.mjs")),
    ];
    const alphaEvents = [
      { id: "evt_a1", type: "session.usage.updated", location: { directory: alpha }, data: { sessionID: "ses_a1", cost: 0.25, tokens: { input: 10, output: 20 } } },
      { id: "evt_a2", type: "session.execution.failed", location: { directory: alpha }, data: { sessionID: "ses_a1", error: new Error("provider down") } },
      { id: "evt_a3", type: "session.idle", location: { directory: alpha }, data: { sessionID: "ses_a1" } },
      { id: "evt_a4", type: "session.usage.updated", location: { directory: alpha }, data: { sessionID: "ses_a2", cost: 0.1, tokens: {} } },
      { id: "evt_a5", type: "session.usage.updated", location: { directory: alpha }, data: { sessionID: "ses_a3", cost: 0.05, tokens: {} } },
    ];
    const betaHooks = [
      ["permission.evaluate", {
        sessionID: "ses_b1",
        agent: "build",
        action: "bash",
        resources: [PUSH],
        effect: "deny",
        message: "needs approval",
      }],
      ...failedBash("ses_b2", "call_b2_build", "npm run build"),
    ];
    const betaEvents = [
      { id: "evt_b1", type: "session.usage.updated", location: { directory: beta }, data: { sessionID: "ses_b1", cost: 0.4, tokens: {} } },
      {
        id: "evt_b2",
        type: "session.compaction.ended",
        location: { directory: beta },
        data: {
          sessionID: "ses_b2",
          reason: "auto",
          model: { providerID: "openrouter", modelID: "google/gemini-4-neon" },
          cost: 0.1,
          tokens: { input: 100, output: 50 },
          text: "compacted summary",
        },
      },
      { id: "evt_b3", type: "session.usage.updated", location: { directory: beta }, data: { sessionID: "ses_b2", cost: 0.05, tokens: {} } },
      { id: "evt_b4", type: "session.usage.updated", location: { directory: beta }, data: { sessionID: "ses_b3", cost: 0.02, tokens: {} } },
    ];

    await runAuditPlugin({ auditDir, directory: alpha, events: alphaEvents, hooks: alphaHooks });
    await runAuditPlugin({ auditDir, directory: beta, events: betaEvents, hooks: betaHooks });

    // --- 1. the JSONL on disk is the real plugin output -------------------------------
    const raw = allAuditRecords(auditDir);
    const loaded = raw.filter((record) => record.event === "plugin.loaded");
    assert.equal(loaded.length, 2);
    assert.deepEqual(loaded.map((record) => record.location.directory).sort(), [alpha, beta].sort());
    for (const record of loaded) {
      assert.equal(record.v, 1);
      assert.ok(Number.isFinite(Date.parse(record.ts)), "records carry a parseable ts");
      assert.equal(record.loggingEnabled, true);
      assert.equal(record.plugin, "opencode-workflow-audit");
    }
    assert.ok(raw.every((record) => typeof record.event === "string" && typeof record.ts === "string"));
    assert.ok(raw.some((record) => record.event === "tool.after" && record.status === "error" && record.error?.message === "exit 1"));
    assert.ok(raw.some((record) => record.event === "permission.evaluate" && Array.isArray(record.resources) && record.resources[0] === PUSH));
    assert.ok(raw.some((record) => record.event === "shell.before" && record.cwd === alpha && record.envVarCount === 1));

    // --- 2. workspace scoping must survive the plugin's sparse records ---------------
    const alphaScan = readAuditEntries({ dirs: [auditDir], workspace: alpha, days: 7, now: now + 1000 });
    assert.ok(alphaScan.entries.length > 0);
    assert.deepEqual(
      [...new Set(alphaScan.entries.map((entry) => entry.__session).filter(Boolean))].sort(),
      ["ses_a1", "ses_a2", "ses_a3"],
    );
    assert.ok(
      alphaScan.entries.some((entry) => entry.event === "tool.after"),
      "tool records carry no location.directory and must be attributed through their session",
    );
    assert.equal(alphaScan.entries.every((entry) => entry.__project === "alpha"), true);
    for (const entry of alphaScan.entries) {
      assert.ok(entry.__timestamp !== null);
      assert.ok(Math.abs(entry.__timestamp - Date.parse(entry.ts)) < 1000, "ts drives the timestamp");
    }

    // --- 3. consolidation sees deduplicated, attributed telemetry -------------------
    let promptText = "";
    const llm = async (request) => {
      promptText = request.messages.map((message) => message.content).join("\n");
      return "# MEMORY\n\n## Goal\nalpha shipped\n";
    };
    const memory = await consolidateMemory({
      workspace: alpha,
      auditDirs: [auditDir],
      llm,
      dryRun: true,
      days: 7,
      now: now + 1000,
    });
    assert.equal(memory.written, false);
    assert.ok(memory.auditFiles.length >= 1);
    assert.deepEqual(memory.summary.global.projects, ["alpha"]);
    assert.equal(memory.summary.global.toolCalls, 5, "tool.before/tool.after pairs count once");
    assert.equal(memory.summary.global.toolErrors, 2);
    assert.ok(Math.abs(memory.summary.global.errorRate - 0.4) < 1e-9);
    assert.equal(memory.summary.global.permissionBlocks, 1);
    assert.ok(memory.summary.global.commands.includes("npm test"), "input.command from tool.after");
    assert.ok(memory.summary.global.commands.includes("ls -la"), "command from shell.before");
    assert.ok(memory.summary.global.files.includes(join(alpha, "main.mjs")), "input.filePath from tool.after");
    assert.equal(memory.summary.sessions.length, 3, "unattributed records are not a session");
    assert.match(promptText, /Tool calls: 5; failures: 2; permission blocks: 1/);

    // --- 4. the RSI review parses the same directory --------------------------------
    const agentsPath = join(root, "AGENTS.md");
    const configPath = join(root, "opencode.jsonc");
    writeFileSync(agentsPath, "# rules\n", "utf8");
    writeFileSync(configPath, "{}", "utf8");
    const report = await runRsiPrune({
      auditDirs: [auditDir],
      agentsPaths: [agentsPath],
      configPaths: [configPath],
      knownSkills: ["used-skill", "dead-skill"],
      days: 7,
      now: now + 1000,
    });
    assert.equal(report.guard.allowed, true);
    assert.equal(report.guard.distinctProjects, 2, "unattributable records must not create a project");
    assert.equal(report.guard.totalSessions, 6);
    assert.ok(report.guard.unidentifiedEntries >= 1, "plugin.loaded/stopped style records have no project");
    assert.equal(report.toolStats.calls, 6, "six terminal tool records, not twelve");
    assert.equal(report.toolStats.errors, 3);
    assert.ok(Math.abs(report.toolStats.errorRate - 0.5) < 1e-9);
    assert.deepEqual(report.toolStats.byTool, [
      { tool: "bash", calls: 3 },
      { tool: "read", calls: 3 },
    ]);
    const byProject = new Map(report.projects.map((project) => [project.project, project]));
    assert.equal(byProject.get("alpha").sessions, 3);
    assert.equal(byProject.get("alpha").toolCalls, 5);
    assert.equal(byProject.get("alpha").errors, 2);
    assert.equal(byProject.get("beta").sessions, 3);
    assert.equal(byProject.get("beta").toolCalls, 1);
    assert.equal(byProject.get("beta").errors, 1);
    assert.equal(report.permissions.blocks, 2);
    assert.deepEqual(report.permissions.byResource, [
      { resource: PUSH, blocks: 2, evidence: { distinctProjects: 2, sessions: 2 } },
    ]);
    assert.deepEqual(report.shell.failures, [
      { command: "git push origin", failures: 2, evidence: { distinctProjects: 2, sessions: 2 } },
      { command: "npm test", failures: 2, evidence: { distinctProjects: 1, sessions: 1 } },
      { command: "npm run build", failures: 1, evidence: { distinctProjects: 1, sessions: 1 } },
    ], "blocked shell actions count as shell friction, not just failed bash tool calls");
    assert.deepEqual(
      report.models.map((model) => [model.model, model.turns, model.costUSD]),
      [["openrouter/google/gemini-4-neon", 2, 0.15]],
      "compaction.ended model object is normalized to provider/model and enriches subsequent session.usage.updated records",
    );
    const recent = new Map(report.recentSessions.map((session) => [session.session, session]));
    assert.equal(recent.get("ses_a1").costUSD, 0.25, "session.usage.updated cost");
    assert.equal(recent.get("ses_b2").costUSD, 0.15, "usage + compaction cost");
    assert.ok(recent.has("ses_b3"));
    // Real fixture evidence: PUSH was blocked in 2 sessions of 2 projects and `npm test` failed in
    // 1 session of 1 project. Neither is cross-project evidence for a GLOBAL rule change, so the
    // per-proposal guard withholds both even though the global 2-project/5-session guard passed.
    const withheld = new Map(report.pruning.withheld.map((proposal) => [`${proposal.kind}:${proposal.target}`, proposal]));
    const withheldPush = withheld.get(`permission-rule:${PUSH}`);
    assert.ok(withheldPush, "a 2-session block pattern must not become a global permission proposal");
    assert.deepEqual(withheldPush.evidence, { distinctProjects: 2, sessions: 2, forced: false });
    assert.match(withheldPush.withheldReason, /at least 2 projects and 5 sessions/u);
    const withheldShell = withheld.get("shell-guidance:npm test");
    assert.ok(withheldShell);
    assert.deepEqual(withheldShell.evidence, { distinctProjects: 1, sessions: 1, forced: false });
    assert.deepEqual(
      report.pruning.proposals.filter((proposal) => ["permission-rule", "shell-guidance"].includes(proposal.kind)),
      [],
    );
    assert.ok(report.warnings.some((warning) => /PER-PROPOSAL GUARD/.test(warning) && warning.includes(PUSH)));
    assert.equal(report.skills.observations, 0);
    assert.deepEqual(report.pruning.proposals.filter((proposal) => proposal.kind === "dead-skill"), []);
    assert.ok(report.warnings.some((warning) => /UNOBSERVED/.test(warning)));
    assert.ok(report.warnings.some((warning) => /could not be attributed/.test(warning)));
  });
});
