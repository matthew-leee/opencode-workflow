// System-1 Supervisor: a thin @opencode/client outer loop. It creates a fresh OpenCode v2
// session per PLAN.md milestone, watches live events, and asks a cheap supervisor model for a
// semantic action at meaningful checkpoints. It never applies turn/token cutoffs; the only hard
// stop is an extreme spend fuse. Every action is audited, and pause_for_human is announced with
// a five-line notification (stdout, notifications.log, optional webhook).

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

import {
  createOpenRouterClientFromEnv,
  extractJsonObject,
  redactSecrets,
  validateRequiredFields,
} from "./openrouter-client.mjs";
import { DEFAULT_MEMORY_MODEL, consolidateMemory, readMemoryContext } from "./memory-consolidate.mjs";

export { DEFAULT_MEMORY_MODEL };

export const SUPERVISOR_ACTIONS = Object.freeze([
  "continue",
  "steer",
  "escalate_opus",
  "escalate_fable",
  "fresh_session",
  "complete",
  "pause_for_human",
]);
export const DEFAULT_SUPERVISOR_MODEL = "deepseek/deepseek-v4.1-flash-1017";
export const DEFAULT_MAX_USD_PER_SESSION = 15;
/** Cumulative spend ceiling defaults to twice the session ceiling, never "unlimited". */
export const DEFAULT_MAX_USD_TOTAL_MULTIPLIER = 2;
export const DEFAULT_MAX_USD_TOTAL = DEFAULT_MAX_USD_PER_SESSION * DEFAULT_MAX_USD_TOTAL_MULTIPLIER;
export const DEFAULT_TOOL_CALL_CHECKPOINT = 15;
export const MAX_TOOL_CALL_CHECKPOINT = 10_000;
export const MAX_ERROR_THRESHOLD = 100;
export const MAX_ERROR_WINDOW = 100;
export const DEFAULT_ERROR_THRESHOLD = 3;
export const DEFAULT_ERROR_WINDOW = 5;
export const DEFAULT_SESSION_AGENT = "build";
const NOTIFICATION_LINES = 5;
const AUDIT_FILE = "supervisor.jsonl";

/**
 * Raised when a numeric supervisor option is not a usable fuse value.
 * A NaN/Infinity/0/negative limit would silently disable a spend or checkpoint fuse, which is
 * strictly worse than refusing to start, so these values are rejected instead of coerced.
 */
export class InvalidSupervisorOptionError extends Error {
  constructor(name, value, expectation) {
    const rendered = typeof value === "number" ? String(value) : JSON.stringify(String(value));
    super(`${name} ${expectation} (received ${rendered})`);
    this.name = "InvalidSupervisorOptionError";
    this.code = "invalid_supervisor_option";
    this.option = name;
    this.value = rendered;
  }
}

function isUnset(value) {
  if (value === undefined || value === null) return true;
  return typeof value === "string" && value.trim() === "";
}

/**
 * Accepts only a finite number greater than zero; anything else is a hard configuration error.
 *
 * The fallback is validated by the same rule, not trusted: a *derived* default such as
 * `maxUsdPerSession * DEFAULT_MAX_USD_TOTAL_MULTIPLIER` overflows to `Infinity` once
 * `maxUsdPerSession` is `Number.MAX_VALUE`, which would silently disable the cumulative spend
 * fuse. Every fuse must be finite before the supervisor is allowed to start.
 */
export function strictPositiveNumber(value, fallback, name) {
  if (isUnset(value)) {
    const derived = Number(fallback);
    if (!Number.isFinite(derived) || derived <= 0) {
      throw new InvalidSupervisorOptionError(name, fallback, "must be a finite number greater than 0");
    }
    return derived;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new InvalidSupervisorOptionError(name, value, "must be a finite number greater than 0");
  }
  return numeric;
}

/** Accepts only a positive integer within `max`; NaN/Infinity/fractions are rejected. */
export function strictPositiveInteger(value, fallback, name, { max = Number.MAX_SAFE_INTEGER } = {}) {
  const numeric = strictPositiveNumber(value, fallback, name);
  if (!Number.isInteger(numeric) || numeric > max) {
    throw new InvalidSupervisorOptionError(name, value, `must be an integer between 1 and ${max}`);
  }
  return numeric;
}
const EVENT_TYPES = [
  "session.tool.called",
  "session.tool.success",
  "session.tool.failed",
  "session.idle",
  "session.usage.updated",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
];

/**
 * Terminal execution events are checkpoints in their own right: they mean the agent finished a
 * turn, so a supervisor decision is both possible and useful even when no tool-call checkpoint or
 * idle event arrived first. `failed` counts as an error signal; `interrupted` is terminal but not
 * an error (the supervisor itself may have interrupted the session).
 */
const EXECUTION_TERMINAL_EVENTS = new Map([
  ["session.execution.succeeded", { label: "execution", failed: false, trigger: "execution_succeeded" }],
  ["session.execution.failed", { label: "execution", failed: true, trigger: "execution_failed" }],
  ["session.execution.interrupted", { label: "execution", failed: false, trigger: "execution_interrupted" }],
]);

/**
 * Human-readable tool label for telemetry.
 *
 * The event payload differs per OpenCode code path: native tools arrive as `data.native.name`
 * (e.g. `apply_patch`), plugin/tool events as `data.tool`, and some records only carry a generic
 * `name`/`id`. Without the native name every supervisor summary collapses to "tool" or an opaque
 * id, which makes semantic decisions guesswork.
 */
export function toolLabel(data) {
  const native = data?.native;
  const nativeName = typeof native === "string" ? native : native?.name;
  for (const candidate of [nativeName, data?.tool, data?.name, data?.id]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return "tool";
}

export const MILESTONE_PATTERN = /^(\s*)[-*]\s+\[([ xX])\]\s+(.*)$/u;

function sliceCodePoints(value, max) {
  const points = Array.from(String(value ?? ""));
  return points.length <= max ? points.join("") : points.slice(0, max).join("");
}

/** Parses every `- [ ]` / `- [x]` checklist item from PLAN.md text. */
export function parseMilestones(planText) {
  const milestones = [];
  String(planText ?? "").split(/\r?\n/).forEach((raw, index) => {
    const match = raw.match(MILESTONE_PATTERN);
    if (!match) return;
    const text = match[3].trim();
    if (!text) return;
    milestones.push({
      lineNumber: index + 1,
      line: raw,
      indent: match[1],
      checked: match[2].toLowerCase() === "x",
      text,
    });
  });
  return milestones;
}

export function uncheckedMilestones(planText) {
  return parseMilestones(planText).filter((milestone) => !milestone.checked);
}

function atomicWrite(file, content) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  try {
    writeFileSync(tmp, content, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, file);
  } catch (error) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best effort */ }
    throw error;
  }
}

/**
 * Marks a PLAN.md milestone as completed with a single atomic rewrite.
 * `milestone` may be a parse result or its exact text. Ambiguous text is rejected.
 */
export function markMilestoneCompleted(planPath, milestone, { done = true, now = Date.now() } = {}) {
  const file = resolve(planPath);
  const original = readFileSync(file, "utf8");
  const plan = parseMilestones(original);
  const targetText = typeof milestone === "string" ? milestone.trim() : milestone?.text?.trim();
  const targetLine = typeof milestone === "object" && milestone?.lineNumber ? milestone.lineNumber : null;

  let matches = plan.filter((item) => item.checked !== done && item.text === targetText);
  if (targetLine) matches = matches.filter((item) => item.lineNumber === targetLine);
  if (matches.length === 0) {
    const already = plan.filter((item) => item.text === targetText && item.checked === done);
    if (already.length > 0) return { changed: false, already: true, line: already[0].line };
    throw new Error(`Milestone not found: ${targetText ?? "(missing text)"}`);
  }
  if (matches.length > 1) {
    throw new Error(`Ambiguous milestone text (${matches.length} matches): ${targetText}`);
  }

  const match = matches[0];
  const lines = original.split(/(\r?\n)/);
  // Split with separators keeps line indices even; lineNumber is 1-based.
  const lineIndex = (match.lineNumber - 1) * 2;
  const before = lines[lineIndex];
  const after = before.replace(/\[([ xX])\]/u, done ? "[x]" : "[ ]");
  if (before === after) return { changed: false, already: true, line: before };
  lines[lineIndex] = after;
  const next = lines.join("");
  atomicWrite(file, next);
  return { changed: true, line: after, before, after, markedAt: new Date(now).toISOString() };
}

function normalizeAction(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

/** Conservative fallback when the supervisor model returns malformed output. */
export function fallbackDecision({ reason = "malformed supervisor output", errors = 0, threshold = DEFAULT_ERROR_THRESHOLD } = {}) {
  if (errors >= threshold) {
    return {
      action: "steer",
      rationale: `${reason}; repeated failures detected, so ask for diagnosis instead of continuing blindly`,
      message: "Diagnose the repeated failures before the next change. State the failing check, the suspected cause, and the smallest experiment that distinguishes them.",
      fallback: true,
    };
  }
  return {
    action: "continue",
    rationale: `${reason}; no repeated-failure evidence, so keep the current strategy`,
    message: "",
    fallback: true,
  };
}

/** Validates a parsed LLM decision; malformed actions fall back conservatively. */
export function normalizeDecision(input, stats = {}) {
  let parsed = input;
  if (typeof input === "string") {
    try {
      parsed = extractJsonObject(input);
    } catch {
      return fallbackDecision({ ...stats, reason: "supervisor response was not JSON" });
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return fallbackDecision({ ...stats, reason: "supervisor response was not an object" });
  }
  const action = normalizeAction(parsed.action);
  if (!SUPERVISOR_ACTIONS.includes(action)) {
    return fallbackDecision({ ...stats, reason: `unknown supervisor action: ${sliceCodePoints(parsed.action, 60)}` });
  }
  let rationale = typeof parsed.rationale === "string" ? parsed.rationale.trim() : "";
  if (!rationale) rationale = "Supervisor chose this action without a stated rationale";
  const message = typeof parsed.message === "string" ? parsed.message.trim() : "";
  return {
    action,
    rationale: sliceCodePoints(rationale, 1000),
    message: sliceCodePoints(message, 4000),
    fallback: false,
  };
}

function extractText(result) {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return "";
  if (typeof result.text === "string") return result.text;
  if (typeof result.content === "string") return result.content;
  if (typeof result.data?.text === "string") return result.data.text;
  if (typeof result.data?.content === "string") return result.data.content;
  return "";
}

async function callSupervisorModel(llm, request) {
  if (!llm) throw new Error("No supervisor model supplied (pass `llm` or set OPENROUTER_API_KEY)");
  let result;
  if (typeof llm === "function") result = await llm(request);
  else if (typeof llm.chatJson === "function") result = await llm.chatJson(request);
  else if (typeof llm.chat === "function") result = await llm.chat(request);
  else throw new Error("The supervisor model must be a function or expose chatJson()/chat()");
  return result;
}

function buildDecisionPrompt({ milestone, project, memory, stats, recent, model, trigger }) {
  const system = [
    "You are a System-1 supervisor for an autonomous coding agent.",
    "Judge semantic progress, spin, repeated failures, and whether the milestone is genuinely complete.",
    "Return STRICT JSON only, with no markdown fence, matching this shape:",
    '{"action":"continue|steer|escalate_opus|escalate_fable|fresh_session|complete|pause_for_human","rationale":"short evidence-based reason","message":"optional instruction to the agent"}',
    "continue = keep the current strategy; steer = give a concrete correction; escalate_* = switch to a stronger agent; fresh_session = abandon a polluted context; complete = the milestone is demonstrably finished; pause_for_human = only for a decision or risk that needs the user.",
    "Do not use turn counts as a stop condition. Base the decision on observed evidence.",
  ].join("\n");
  const user = [
    `Project: ${project}`,
    `Milestone: ${milestone.text}`,
    `Checkpoint trigger: ${trigger}`,
    `Supervisor model: ${model}`,
    "",
    "Project MEMORY.md (bounded):",
    memory.trim() || "(none)",
    "",
    `Session telemetry: toolCalls=${stats.toolCalls} errors=${stats.errors} recentErrors=${stats.recentErrors}/${stats.recentOutcomes} costUSD=$${stats.costUSD.toFixed(4)} totalCostUSD=$${(stats.totalCostUSD ?? stats.costUSD).toFixed(4)} idle=${stats.idle ? "yes" : "no"}`,
    `Recent tool outcomes: ${stats.recentDetails.length ? stats.recentDetails.join(", ") : "(none)"}`,
    `Files changed: ${stats.files.length ? stats.files.join(", ") : "(none observed)"}`,
    "",
    "Choose one action and justify it from this evidence.",
  ].join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

async function decide({ ctx, milestone, sessionID, stats, trigger }) {
  const request = {
    purpose: "decision",
    model: ctx.model,
    messages: buildDecisionPrompt({
      milestone,
      project: ctx.project,
      memory: ctx.memory,
      stats,
      model: ctx.model,
      trigger,
    }),
    maxTokens: 1024,
    reasoning: { effort: "low" },
    temperature: 0.2,
  };
  try {
    const result = await callSupervisorModel(ctx.llm, request);
    if (result && typeof result === "object" && result.data && typeof result.data === "object") {
      return normalizeDecision(result.data, { errors: stats.recentErrors, threshold: ctx.errorThreshold });
    }
    return normalizeDecision(extractText(result), { errors: stats.recentErrors, threshold: ctx.errorThreshold });
  } catch (error) {
    return fallbackDecision({
      errors: stats.recentErrors,
      threshold: ctx.errorThreshold,
      reason: `supervisor model call failed: ${redactSecrets(error?.message ?? error, ctx.apiKey)}`,
    });
  }
}

/** Builds the exactly-five-line human notification for a pause. */
export function buildPauseNotification({ project, milestone, rationale, sessionID, now = Date.now() }) {
  return [
    `[SUPERVISOR PAUSED] ${new Date(now).toISOString()}`,
    `Project: ${project}`,
    `Milestone: ${sliceCodePoints(milestone, 180)}`,
    `Reason: ${sliceCodePoints(rationale, 300)}`,
    `Next: inspect session ${sessionID} and resume manually`,
  ];
}

async function notifyPause(ctx, payload) {
  const lines = buildPauseNotification({ ...payload, now: ctx.now() });
  if (lines.length !== NOTIFICATION_LINES) throw new Error("Pause notification must be exactly five lines");
  for (const line of lines) ctx.log(line);
  mkdirSync(dirname(ctx.notificationsLogPath), { recursive: true });
  appendFileSync(ctx.notificationsLogPath, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });

  let webhookSent = false;
  if (ctx.notifyWebhookUrl) {
    try {
      const fetchImpl = ctx.fetchImpl ?? globalThis.fetch;
      if (typeof fetchImpl === "function") {
        const response = await fetchImpl(ctx.notifyWebhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            text: lines.join("\n"),
            project: payload.project,
            milestone: payload.milestone,
            sessionID: payload.sessionID,
            rationale: payload.rationale,
          }),
        });
        webhookSent = Boolean(response?.ok);
      }
    } catch (error) {
      ctx.log(`Webhook notification failed: ${redactSecrets(error?.message ?? error, ctx.apiKey)}`);
    }
  }
  return { lines, webhookSent };
}

export function appendAuditEntry(auditDir, entry) {
  mkdirSync(auditDir, { recursive: true });
  appendFileSync(join(auditDir, AUDIT_FILE), `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
}

function summarizeRecent(outcomes) {
  return outcomes.map((outcome) => outcome.error ? `${outcome.tool} FAILED` : `${outcome.tool} ok`);
}

async function createSession(ctx, milestone, reason) {
  const session = await ctx.client.session.create({
    title: `supervisor: ${sliceCodePoints(milestone.text, 80)}`,
    agent: DEFAULT_SESSION_AGENT,
    location: { directory: ctx.workspace },
  });
  if (!session?.id) throw new Error("OpenCode session.create returned no session id");
  ctx.sessions.push({ id: session.id, milestone: milestone.text, reason, createdAt: new Date(ctx.now()).toISOString() });
  return session.id;
}

function buildInitialPrompt(ctx, milestone) {
  return [
    `Project: ${ctx.project}`,
    `Milestone from PLAN.md: ${milestone.text}`,
    "",
    "Project MEMORY.md:",
    ctx.memory.trim() || "(none)",
    "",
    "Work on this milestone now. Make the smallest correct change, run the relevant checks, and report concrete evidence (commands, outputs, files). Do not stop merely because you completed a turn; stop when the milestone is genuinely complete or you are blocked.",
  ].join("\n");
}

async function promptSession(ctx, sessionID, text, { delivery = "queue", reason = "prompt" } = {}) {
  await ctx.client.session.prompt({ sessionID, text, delivery });
  ctx.prompts.push({ sessionID, text, delivery, reason, at: new Date(ctx.now()).toISOString() });
}

function eventSessionID(event) {
  return String(event?.data?.sessionID ?? event?.sessionID ?? "");
}

function eventType(event) {
  return String(event?.type ?? "");
}

async function pause(ctx, { milestone, sessionID, rationale, fuse = false, spend = null }) {
  const notification = await notifyPause(ctx, {
    project: ctx.project,
    milestone: milestone.text,
    rationale,
    sessionID,
  });
  appendAuditEntry(ctx.auditDir, {
    type: fuse ? "supervisor.spend_fuse" : "supervisor.pause",
    at: new Date(ctx.now()).toISOString(),
    project: ctx.project,
    workspace: ctx.workspace,
    sessionID,
    milestone: milestone.text,
    rationale,
    ...(spend
      ? {
        sessionSpentUsd: Number(spend.sessionSpentUsd.toFixed(4)),
        totalSpentUsd: Number(spend.totalSpentUsd.toFixed(4)),
        maxUsdPerSession: ctx.maxUsdPerSession,
        maxUsdTotal: ctx.maxUsdTotal,
      }
      : {}),
    notificationLines: notification.lines,
    webhookSent: notification.webhookSent,
  });
  return { terminal: true, status: "paused", reason: rationale, notification };
}

async function applyAction(ctx, { decision, milestone, sessionID, stats, trigger }) {
  appendAuditEntry(ctx.auditDir, {
    type: "supervisor.decision",
    at: new Date(ctx.now()).toISOString(),
    project: ctx.project,
    workspace: ctx.workspace,
    sessionID,
    milestone: milestone.text,
    trigger,
    action: decision.action,
    rationale: decision.rationale,
    message: decision.message || "",
    fallback: Boolean(decision.fallback),
    toolCalls: stats.toolCalls,
    errors: stats.errors,
    recentErrors: stats.recentErrors,
    costUSD: Number(stats.costUSD.toFixed(4)),
    totalCostUSD: Number((stats.totalCostUSD ?? stats.costUSD).toFixed(4)),
  });
  ctx.decisions.push({ action: decision.action, rationale: decision.rationale, message: decision.message, trigger, fallback: Boolean(decision.fallback), milestone: milestone.text });

  switch (decision.action) {
    case "complete": {
      const marked = markMilestoneCompleted(ctx.planPath, milestone, { now: ctx.now() });
      let memory = null;
      let memoryError = null;
      try {
        memory = await ctx.consolidate({
          workspace: ctx.workspace,
          project: ctx.project,
          memoryPath: ctx.memoryPath,
          auditDirs: [ctx.auditDir],
          llm: ctx.llm,
          model: ctx.memoryModel,
          now: ctx.now(),
          dryRun: ctx.dryRun,
        });
      } catch (error) {
        memoryError = redactSecrets(error?.message ?? error, ctx.apiKey);
      }
      appendAuditEntry(ctx.auditDir, {
        type: "supervisor.complete",
        at: new Date(ctx.now()).toISOString(),
        project: ctx.project,
        sessionID,
        milestone: milestone.text,
        marked,
        memoryWritten: Boolean(memory?.written),
        memoryCharacters: memory?.characters ?? null,
        memoryError,
      });
      return { terminal: true, status: "completed", completed: true, marked, memory, memoryError };
    }
    case "pause_for_human":
      return pause(ctx, { milestone, sessionID, rationale: decision.rationale });
    case "fresh_session": {
      try { await ctx.client.session.interrupt({ sessionID }); } catch { /* already idle */ }
      const nextID = await createSession(ctx, milestone, "fresh_session");
      ctx.memory = readMemoryContext(ctx.memoryPath) || ctx.memory;
      await promptSession(ctx, nextID, buildInitialPrompt(ctx, milestone), { reason: "fresh_session" });
      appendAuditEntry(ctx.auditDir, {
        type: "supervisor.fresh_session",
        at: new Date(ctx.now()).toISOString(),
        project: ctx.project,
        previousSessionID: sessionID,
        sessionID: nextID,
        milestone: milestone.text,
        rationale: decision.rationale,
      });
      return { sessionID: nextID, transitioned: true };
    }
    case "escalate_opus":
    case "escalate_fable": {
      const agent = decision.action === "escalate_opus" ? "escalate-opus" : "escalate-fable";
      if (typeof ctx.client.session.switchAgent === "function") {
        await ctx.client.session.switchAgent({ sessionID, agent });
      }
      await promptSession(
        ctx,
        sessionID,
        decision.message || `Continue this milestone as ${agent}. Diagnose what is blocking progress and report evidence for the next check.`,
        { reason: decision.action },
      );
      appendAuditEntry(ctx.auditDir, {
        type: "supervisor.escalation",
        at: new Date(ctx.now()).toISOString(),
        project: ctx.project,
        sessionID,
        agent,
        milestone: milestone.text,
        rationale: decision.rationale,
      });
      return { escalatedTo: agent };
    }
    case "steer":
      await promptSession(ctx, sessionID, decision.message || "Adjust course: state the failing check and make the smallest change that produces new evidence.", { reason: "steer" });
      return {};
    case "continue":
    default:
      // At an idle checkpoint a bare `continue` would stall forever. A neutral nudge is the
      // semantic equivalent of continuing the same strategy, not a new turn limit.
      if (trigger === "idle") {
        await promptSession(ctx, sessionID, decision.message || "Continue working on the milestone. Report the next concrete check and its result.", { reason: "continue_idle" });
      }
      return {};
  }
}

async function runMilestone(ctx, milestone) {
  let sessionID = await createSession(ctx, milestone, "milestone_start");
  // Spend accounting has two independent ceilings.
  //
  // `sessionSpentUsd` is the spend of the *current accounting epoch*: a fresh session or an agent
  // escalation starts a new epoch, and it is measured against `maxUsdPerSession`. Every finished
  // epoch is folded into `ctx.finalizedSpentUsd`, so `totalSpentUsd()` keeps growing across fresh
  // sessions and milestones and is measured against `maxUsdTotal`. Without the fold, opening a new
  // session would reset the only spend counter and make the cumulative fuse trivially bypassable.
  let sessionCostUSD = 0;
  let epochBaselineUSD = 0;
  let sessionSpentUsd = 0;
  const totalSpentUsd = () => ctx.finalizedSpentUsd + sessionSpentUsd;
  const finalizeEpoch = () => {
    ctx.finalizedSpentUsd += sessionSpentUsd;
    sessionSpentUsd = 0;
  };
  const spendState = () => ({ sessionSpentUsd, totalSpentUsd: totalSpentUsd() });
  const sessionFuseTripped = () => sessionSpentUsd >= ctx.maxUsdPerSession;
  const totalFuseTripped = () => totalSpentUsd() >= ctx.maxUsdTotal;
  let toolCalls = 0;
  let errors = 0;
  let toolCallsSinceDecision = 0;
  const outcomes = [];
  const files = new Set();
  let idle = false;

  const iterator = ctx.client.event.subscribe({ types: EVENT_TYPES, signal: ctx.signal })[Symbol.asyncIterator]();
  try {
    await promptSession(ctx, sessionID, buildInitialPrompt(ctx, milestone), { reason: "initial" });

    while (true) {
      if (ctx.signal?.aborted) return { terminal: true, status: "aborted" };
      const step = await iterator.next();
      if (step.done) {
        return { terminal: false, status: "incomplete", rationale: "event stream ended before a completion decision" };
      }
      const event = step.value;
      if (eventSessionID(event) !== sessionID) continue;
      const type = eventType(event);

      if (type === "session.usage.updated") {
        const reported = Number(event?.data?.cost);
        if (Number.isFinite(reported) && reported >= 0) {
          sessionCostUSD = Math.max(sessionCostUSD, reported);
          // Provider cost is cumulative per OpenCode session; the epoch baseline isolates the
          // spend that happened after the current fresh-session/escalation boundary.
          sessionSpentUsd = Math.max(sessionSpentUsd, sessionCostUSD - epochBaselineUSD);
        }
        if (sessionFuseTripped() || totalFuseTripped()) {
          const rationale = sessionFuseTripped()
            ? `Spend fuse: session spend $${sessionSpentUsd.toFixed(2)} reached maxUsdPerSession $${ctx.maxUsdPerSession.toFixed(2)}`
            : `Spend fuse: cumulative spend $${totalSpentUsd().toFixed(2)} reached maxUsdTotal $${ctx.maxUsdTotal.toFixed(2)}`;
          return pause(ctx, { milestone, sessionID, rationale, fuse: true, spend: spendState() });
        }
      }

      if (type === "session.tool.called") {
        toolCalls += 1;
        toolCallsSinceDecision += 1;
        const input = event?.data?.input ?? {};
        const candidateFile = input.filePath ?? input.path ?? input.file;
        if (typeof candidateFile === "string") files.add(candidateFile);
      }
      if (type === "session.tool.success" || type === "session.tool.failed") {
        const failed = type === "session.tool.failed";
        outcomes.push({ tool: toolLabel(event?.data), error: failed, at: ctx.now() });
        if (outcomes.length > ctx.errorWindow) outcomes.shift();
        if (failed) errors += 1;
      }
      if (type === "session.idle") idle = true;
      let executionTrigger = null;
      const terminal = EXECUTION_TERMINAL_EVENTS.get(type);
      if (terminal) {
        outcomes.push({ tool: terminal.label, error: terminal.failed, at: ctx.now() });
        if (outcomes.length > ctx.errorWindow) outcomes.shift();
        if (terminal.failed) errors += 1;
        executionTrigger = terminal.trigger;
      }

      const recentErrorCount = outcomes.filter((outcome) => outcome.error).length;
      let trigger = null;
      if (toolCallsSinceDecision >= ctx.toolCallCheckpoint) trigger = "tool_calls";
      else if (recentErrorCount >= ctx.errorThreshold) trigger = "errors";
      else if (idle) trigger = "idle";
      else if (executionTrigger) trigger = executionTrigger;
      if (!trigger) continue;

      if (sessionFuseTripped() || totalFuseTripped()) {
        return pause(ctx, {
          milestone,
          sessionID,
          rationale: sessionFuseTripped()
            ? `Spend fuse reached before a semantic decision: session $${sessionSpentUsd.toFixed(2)}, total $${totalSpentUsd().toFixed(2)}`
            : `Spend fuse reached before a semantic decision: cumulative total $${totalSpentUsd().toFixed(2)} reached maxUsdTotal $${ctx.maxUsdTotal.toFixed(2)}`,
          fuse: true,
          spend: spendState(),
        });
      }

      const stats = {
        toolCalls,
        errors,
        recentErrors: recentErrorCount,
        recentOutcomes: outcomes.length,
        recentDetails: summarizeRecent(outcomes),
        costUSD: sessionSpentUsd,
        totalCostUSD: totalSpentUsd(),
        idle,
        files: [...files],
      };
      const decision = await decide({ ctx, milestone, sessionID, stats, trigger });
      const result = await applyAction(ctx, { decision, milestone, sessionID, stats, trigger });
      if (result.terminal) return result;
      if (result.transitioned) {
        // A fresh session is a new spend epoch: finalize what was spent so far (it still counts
        // toward the cumulative fuse) and restart the per-session counter at zero.
        finalizeEpoch();
        sessionID = result.sessionID;
        sessionCostUSD = 0;
        epochBaselineUSD = 0;
      } else if (result.escalatedTo) {
        // Escalation keeps the provider session, so its cumulative cost keeps climbing; only the
        // post-escalation slice is charged to the new per-session epoch.
        finalizeEpoch();
        epochBaselineUSD = sessionCostUSD;
      }

      toolCallsSinceDecision = 0;
      outcomes.length = 0;
      idle = false;
    }
  } finally {
    finalizeEpoch();
    try { await iterator.return?.(); } catch { /* subscription cleanup is best effort */ }
  }
}

function buildContext(options) {
  const workspace = resolve(options.workspace ?? process.cwd());
  const project = options.project || basename(workspace);
  // Numeric options are validated before anything else runs: a NaN, Infinity, zero or negative
  // limit would silently disable a fuse, and a supervisor without spend fuses must never start.
  const maxUsdPerSession = strictPositiveNumber(options.maxUsdPerSession, DEFAULT_MAX_USD_PER_SESSION, "maxUsdPerSession");
  const maxUsdTotal = strictPositiveNumber(
    options.maxUsdTotal,
    maxUsdPerSession * DEFAULT_MAX_USD_TOTAL_MULTIPLIER,
    "maxUsdTotal",
  );
  const toolCallCheckpoint = strictPositiveInteger(
    options.toolCallCheckpoint,
    DEFAULT_TOOL_CALL_CHECKPOINT,
    "toolCallCheckpoint",
    { max: MAX_TOOL_CALL_CHECKPOINT },
  );
  const errorWindow = strictPositiveInteger(options.errorWindow, DEFAULT_ERROR_WINDOW, "errorWindow", { max: MAX_ERROR_WINDOW });
  const errorThreshold = strictPositiveInteger(options.errorThreshold, DEFAULT_ERROR_THRESHOLD, "errorThreshold", { max: MAX_ERROR_THRESHOLD });
  if (errorThreshold > errorWindow) {
    throw new InvalidSupervisorOptionError("errorThreshold", errorThreshold, `must not exceed errorWindow (${errorWindow})`);
  }
  return {
    workspace,
    project,
    planPath: resolve(options.planPath ?? join(workspace, "PLAN.md")),
    memoryPath: resolve(options.memoryPath ?? join(workspace, "MEMORY.md")),
    auditDir: resolve(options.auditDir ?? join(workspace, ".audit")),
    notificationsLogPath: resolve(options.notificationsLogPath ?? join(workspace, "notifications.log")),
    model: options.model ?? DEFAULT_SUPERVISOR_MODEL,
    memoryModel: options.memoryModel ?? options.model ?? DEFAULT_MEMORY_MODEL,
    maxUsdPerSession,
    maxUsdTotal,
    toolCallCheckpoint,
    errorThreshold,
    errorWindow,
    llm: options.llm,
    client: options.client,
    signal: options.signal,
    dryRun: Boolean(options.dryRun),
    notifyWebhookUrl: options.notifyWebhookUrl ?? process.env.OPENCODE_NOTIFY_WEBHOOK_URL ?? null,
    fetchImpl: options.fetchImpl,
    log: options.log ?? ((line) => console.log(line)),
    now: options.now ?? Date.now,
    apiKey: options.apiKey ?? process.env.OPENROUTER_API_KEY,
    consolidate: options.consolidate ?? consolidateMemory,
    // Spend state: every completed accounting epoch, plus the epoch that is currently running.
    finalizedSpentUsd: 0,
    sessions: [],
    prompts: [],
    decisions: [],
  };
}

function sanitizeSpawnOutput(output) {
  // `opencode serve` prints credentials to stdout. Never let that text reach a log or error.
  return String(output ?? "")
    .replace(/server\s+[^\s]+/gi, "server [REDACTED]")
    .replace(/password[^\n]*/gi, "password [REDACTED]");
}

/**
 * Spawns `opencode serve` and waits for its listening URL and Basic-auth password.
 * The password is returned in memory only; it is never logged or echoed.
 */
export async function spawnManagedServer({
  opencodeBin = "/root/.opencode/bin/opencode",
  workspace = process.cwd(),
  port = 0,
  hostname = "127.0.0.1",
  timeoutMs = 20_000,
  env = process.env,
  spawnImpl = spawn,
} = {}) {
  const args = ["serve", "--hostname", hostname];
  if (port && Number(port) > 0) args.push("--port", String(Number(port)));
  const child = spawnImpl(opencodeBin, args, {
    cwd: workspace,
    env: { ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  let baseUrl = null;
  let password = null;
  let settled = false;

  const close = () => new Promise((resolveClose) => {
    if (child.exitCode !== null || child.killed) return resolveClose();
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      resolveClose();
    }, 3000);
    child.once("exit", () => { clearTimeout(timer); resolveClose(); });
    try { child.kill("SIGTERM"); } catch { clearTimeout(timer); resolveClose(); }
  });

  return await new Promise((resolvePromise, reject) => {
    const fail = async (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      await close();
      reject(error);
    };
    const succeed = () => {
      if (settled || !baseUrl || !password) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ baseUrl, password, child, close });
    };
    const inspect = () => {
      const text = `${stdout}\n${stderr}`.replace(/\u001b\[[0-9;]*m/g, "");
      const listening = text.match(/server listening on (https?:\/\/[^\s]+)/i);
      if (listening) baseUrl = listening[1].replace(/\/$/, "");
      const lines = text.split(/\r?\n/);
      for (const line of lines) {
        const match = line.match(/^\s*server(?:\s+password)?\s+(\S+)\s*$/i);
        if (match) password = match[1];
      }
      succeed();
    };

    const timer = setTimeout(() => {
      fail(new Error(`opencode serve did not report a listening URL and auth token within ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); inspect(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); inspect(); });
    child.once("error", (error) => {
      fail(new Error(`Failed to spawn opencode serve: ${redactSecrets(error?.message ?? error, password ?? "")}`));
    });
    child.once("exit", (code) => {
      if (!settled) fail(new Error(`opencode serve exited before becoming ready (code ${code})`));
    });
  });
}

function makeAuthHeaders(password) {
  if (!password) return {};
  return { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` };
}

async function makeRealClient({ baseUrl, password, fetchImpl }) {
  const { OpenCode } = await import("@opencode/client");
  return OpenCode.make({ baseUrl, headers: makeAuthHeaders(password), fetch: fetchImpl });
}

/**
 * Runs the supervisor.
 *
 * @param {object} options
 * @param {string} [options.workspace=process.cwd()]
 * @param {string} [options.planPath]
 * @param {string} [options.memoryPath]
 * @param {string} [options.auditDir]
 * @param {string} [options.model="deepseek/deepseek-v4.1-flash-1017"]
 * @param {string} [options.memoryModel="deepseek/deepseek-v4.1-flash-1017"]
 * @param {number} [options.maxUsdPerSession=15]
 * @param {number} [options.maxUsdTotal=maxUsdPerSession*2] Cumulative fuse across fresh sessions.
 * @param {Function|object} [options.llm]
 * @param {Function|object} [options.clientFactory] Offline test seam.
 * @param {object} [options.client] Direct client seam.
 * @param {boolean} [options.spawnServer=false]
 * @param {string} [options.baseUrl]
 * @param {string} [options.serverPassword]
 */
export async function runSupervisor(options = {}) {
  const ctx = buildContext(options);
  if (!existsSync(ctx.planPath)) {
    return { status: "no_plan", reason: `PLAN.md not found at ${ctx.planPath}`, completed: [], decisions: [] };
  }
  const planText = readFileSync(ctx.planPath, "utf8");
  const milestones = uncheckedMilestones(planText);
  if (options.maxMilestones) milestones.splice(Number(options.maxMilestones));

  const limits = {
    model: ctx.model,
    memoryModel: ctx.memoryModel,
    maxUsdPerSession: ctx.maxUsdPerSession,
    maxUsdTotal: ctx.maxUsdTotal,
    toolCallCheckpoint: ctx.toolCallCheckpoint,
  };

  if (ctx.dryRun) {
    return { status: "dry_run", milestones, completed: [], decisions: [], planPath: ctx.planPath, ...limits };
  }
  if (milestones.length === 0) {
    return { status: "nothing_to_do", milestones: [], completed: [], decisions: [], planPath: ctx.planPath, ...limits };
  }

  ctx.memory = readMemoryContext(ctx.memoryPath);

  if (!ctx.llm) {
    if (!ctx.apiKey) throw new Error("No supervisor model supplied (pass OPENROUTER_API_KEY or `llm`)");
    ctx.llm = createOpenRouterClientFromEnv({
      model: ctx.model,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.llmTimeoutMs,
    });
  }

  let managed = null;
  let client = ctx.client;
  if (!client) {
    if (options.clientFactory) {
      client = await options.clientFactory();
    } else {
      let baseUrl = options.baseUrl;
      let password = options.serverPassword ?? process.env.OPENCODE_SERVER_PASSWORD;
      if (options.spawnServer) {
        managed = await spawnManagedServer({
          opencodeBin: options.opencodeBin,
          workspace: ctx.workspace,
          port: options.port ?? 0,
          timeoutMs: options.serverTimeoutMs,
        });
        baseUrl = managed.baseUrl;
        password = managed.password;
      }
      if (!baseUrl) throw new Error("Pass --base-url, --spawn-server, or a client/clientFactory");
      client = await makeRealClient({ baseUrl, password, fetchImpl: options.fetchImpl });
    }
  }
  ctx.client = client;

  const completed = [];
  const results = [];
  let status = "completed_all";
  try {
    for (const milestone of milestones) {
      const result = await runMilestone(ctx, milestone);
      results.push({ milestone: milestone.text, ...result });
      if (result.completed) completed.push(milestone.text);
      if (result.status === "paused" || result.status === "aborted") {
        status = result.status;
        break;
      }
      if (result.status === "incomplete") {
        status = "incomplete";
        break;
      }
    }
  } finally {
    if (managed) await managed.close();
  }

  const remaining = existsSync(ctx.planPath) ? uncheckedMilestones(readFileSync(ctx.planPath, "utf8")).map((item) => item.text) : [];
  return {
    status: remaining.length === 0 ? "completed_all" : status,
    project: ctx.project,
    planPath: ctx.planPath,
    memoryPath: ctx.memoryPath,
    model: ctx.model,
    completed,
    remaining,
    decisions: ctx.decisions,
    prompts: ctx.prompts,
    sessions: ctx.sessions,
    ...limits,
    spentUsd: Number(ctx.finalizedSpentUsd.toFixed(4)),
    results,
  };
}

function parseCliArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${arg} requires a value`);
      return argv[i];
    };
    if (arg === "--workspace") options.workspace = next();
    else if (arg === "--plan") options.planPath = next();
    else if (arg === "--memory") options.memoryPath = next();
    else if (arg === "--audit-dir") options.auditDir = next();
    else if (arg === "--model") options.model = next();
    else if (arg === "--memory-model") options.memoryModel = next();
    else if (arg === "--max-usd") options.maxUsdPerSession = next();
    else if (arg === "--max-total-usd") options.maxUsdTotal = next();
    else if (arg === "--tool-checkpoint") options.toolCallCheckpoint = next();
    else if (arg === "--base-url") options.baseUrl = next();
    else if (arg === "--spawn-server") options.spawnServer = true;
    else if (arg === "--opencode-bin") options.opencodeBin = next();
    else if (arg === "--port") options.port = Number(next());
    else if (arg === "--notify-webhook") options.notifyWebhookUrl = next();
    else if (arg === "--once") options.maxMilestones = 1;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function isMainModule() {
  const entry = process.argv[1];
  return Boolean(entry) && pathToFileURL(resolve(entry)).href === import.meta.url;
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node src/supervisor.mjs --workspace DIR [--spawn-server|--base-url URL] [--model ID] [--memory-model ID] [--max-usd 15] [--max-total-usd 30] [--tool-checkpoint 15] [--dry-run]");
    return;
  }
  if (options.dryRun) {
    const result = await runSupervisor(options);
    for (const milestone of result.milestones ?? []) console.log(`- [ ] ${milestone.text}`);
    return;
  }
  const result = await runSupervisor(options);
  console.log(`Supervisor status: ${result.status}`);
  console.log(`Completed: ${result.completed.length}; remaining: ${result.remaining.length}; spent: $${result.spentUsd}`);
  for (const milestone of result.remaining) console.log(`Remaining milestone: ${milestone}`);
  if (result.status === "paused") process.exitCode = 2;
}

if (isMainModule()) {
  main().catch((error) => {
    const message = redactSecrets(error?.message ?? error, process.env.OPENROUTER_API_KEY);
    console.error(`supervisor: ${message}`);
    process.exitCode = 1;
  });
}

export const SUPERVISOR_INTERNALS = Object.freeze({
  sanitizeSpawnOutput,
  buildDecisionPrompt,
  makeAuthHeaders,
  buildInitialPrompt,
  buildContext,
  toolLabel,
  strictPositiveNumber,
  strictPositiveInteger,
});
