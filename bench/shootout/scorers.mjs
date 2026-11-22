// Scoring for the Model Shootout.
//
// Three kinds of checks:
//   * hidden Node test oracles (T1, T2, T4) executed AFTER the model finishes
//   * deterministic anti-cheat checks (public assertions must survive; scope/probe checks)
//   * deterministic rubrics (T3 citation honesty, T5 review quality) over the final answer text
//
// Everything here is offline: no network, no model calls. `runner.mjs` supplies the parsed
// OpenCode metrics and the finished workspace.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, sep } from "node:path";

import {
  countAddedAssertions,
  extractAssertionLines,
  findWeakenedAssertions,
  git,
} from "./tasks.mjs";

/** A task counts as solved at or above this normalized score. */
export const PASS_THRESHOLD = 0.9;

/* ------------------------------------------------------------------------------------------------
 * OpenCode `--format json` parsing
 * ---------------------------------------------------------------------------------------------- */

const TOKEN_KEYS = [
  ["input", ["input", "inputTokens", "prompt", "promptTokens"]],
  ["output", ["output", "outputTokens", "completion", "completionTokens"]],
  ["reasoning", ["reasoning", "reasoningTokens"]],
  ["cacheRead", ["read", "cacheRead", "cache_read", "cacheReadTokens"]],
  ["cacheWrite", ["write", "cacheWrite", "cache_write", "cacheWriteTokens"]],
];

function emptyTokens() {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
}

function addTokens(target, source) {
  for (const [slot, keys] of TOKEN_KEYS) {
    for (const key of keys) {
      const value = source[key];
      if (typeof value === "number" && Number.isFinite(value)) {
        target[slot] += value;
        break;
      }
    }
  }
  return target;
}

function describeError(error) {
  if (error === null || error === undefined) return "unknown error";
  if (typeof error === "string") return error;
  if (typeof error.message === "string") return error.message;
  if (typeof error.data?.message === "string") return error.data.message;
  try {
    return JSON.stringify(error).slice(0, 500);
  } catch {
    return String(error);
  }
}

/**
 * Decode `opencode run --format json` stdout.
 * OpenCode v2.3.2 emits one JSON object per line (JSONL), each shaped
 * `{type, timestamp, sessionID, part}` where `type` is `step_start` | `text` | `tool_use` |
 * `step_finish` (and occasionally `error`), and `part.type` is the kebab-case SDK part type.
 * A single JSON document (object or array) is also accepted.
 */
export function decodeFrames(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text) return { frames: [], mode: "empty", problems: ["empty stdout"] };
  try {
    const parsed = JSON.parse(text);
    const frames = Array.isArray(parsed) ? parsed : [parsed];
    return { frames, mode: "json", problems: [] };
  } catch {
    // fall through to JSONL
  }
  const frames = [];
  const problems = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) frames.push(...parsed);
      else frames.push(parsed);
    } catch {
      problems.push(`unparsed line: ${trimmed.slice(0, 120)}`);
    }
  }
  return { frames, mode: "jsonl", problems };
}

const PATH_KEY_ORDER = ["path", "filePath", "file", "pattern", "command", "workdir", "url"];

/**
 * Every file-ish path a tool call looked at. Shell commands and grep patterns are mined for
 * path-like tokens so a prohibited probe cannot hide inside a command string.
 */
export function collectInspectedPaths(toolCalls) {
  const paths = new Set();
  for (const call of toolCalls ?? []) {
    const input = call.input;
    if (input === null || input === undefined) continue;
    if (typeof input === "string") {
      for (const token of String(input).matchAll(/[\w./@-]*\/[\w./@-]+|[\w.-]+\.(?:mjs|cjs|js|json|jsonc|md|txt)/g)) {
        paths.add(token[0]);
      }
      continue;
    }
    if (typeof input !== "object") continue;
    for (const key of PATH_KEY_ORDER) {
      const value = input[key];
      if (typeof value !== "string") continue;
      if (key === "command" || key === "pattern") {
        for (const token of value.matchAll(/[\w./@-]*\/[\w./@-]+|[\w.-]+\.(?:mjs|cjs|js|json|jsonc|md|txt)/g)) {
          paths.add(token[0]);
        }
      } else {
        paths.add(value);
      }
    }
  }
  return [...paths];
}

/**
 * Extract shootout metrics from decoded frames.
 * @param {object} input
 * @param {object[]} input.frames
 * @param {object|null} input.pricing USD per 1M tokens (roster snapshot) for the cost fallback
 * @param {number} input.durationMs wall-clock duration measured by the runner
 */
export function extractMetrics({ frames, pricing = null, durationMs = 0 }) {
  const eventTypes = new Map();
  const tokens = emptyTokens();
  const toolCalls = [];
  const textChunks = [];
  const messageTexts = new Map();
  const errors = [];
  const seen = new Set();
  let reportedCost = 0;
  let estimatedCost = 0;
  let sawReportedCost = false;
  const stepKeys = () => (frameSteps.size > 0 ? frameSteps : partSteps);
  const frameSteps = new Set();
  const partSteps = new Set();
  let assistantMessages = 0;

  const noteType = (type, node) => {
    if (typeof type !== "string") return;
    eventTypes.set(type, (eventTypes.get(type) ?? 0) + 1);
    if (/^step[-_]finish$/i.test(type)) {
      // v2.3.2 emits each step finish twice: a frame (`step_finish`, carrying `part.id`) and its
      // kebab-case part (`step-finish`). Prefer frame-level counting and fall back to part-level
      // counting for older flat streams, so a step is never counted twice.
      if (type === "step_finish") frameSteps.add(node.part?.id ?? node.timestamp);
      else partSteps.add(node.id ?? `${node.messageID ?? ""}:${node.time?.end ?? ""}`);
    }
    if (/message[-_]?(assistant)?$/i.test(type) && /assistant/i.test(type)) assistantMessages += 1;
  };

  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);

    if (typeof node.type === "string") noteType(node.type, node);

    let stepCostReported = false;
    if (typeof node.cost === "number" && Number.isFinite(node.cost)) {
      reportedCost += node.cost;
      sawReportedCost = true;
      stepCostReported = true;
    }
    if (node.tokens && typeof node.tokens === "object") {
      // A tokens object may carry a nested `cache: { read, write }` bucket.
      const flat = { ...node.tokens };
      if (node.tokens.cache && typeof node.tokens.cache === "object") {
        flat.read = node.tokens.cache.read ?? flat.read;
        flat.write = node.tokens.cache.write ?? flat.write;
      }
      addTokens(tokens, flat);
      // Cost is accounted PER STEP. A step that reports a cost contributes that cost; a step that
      // reports only tokens contributes its own token-based estimate. Summing the two keeps a
      // provider that reports cost for some steps and omits it for others from losing the estimates
      // (the old code discarded every estimate as soon as one step reported a cost).
      if (!stepCostReported) {
        const stepTokens = addTokens(emptyTokens(), flat);
        estimatedCost += computeFallbackCost(stepTokens, pricing);
      }
    }

    const isToolFrame = typeof node.tool === "string" && /tool/i.test(String(node.type ?? "tool"));
    if (isToolFrame) {
      const state = node.state ?? {};
      const call = {
        tool: node.tool,
        status: state.status ?? node.status ?? "unknown",
        input: state.input ?? node.input ?? node.args ?? null,
        error: state.error ?? node.error ?? null,
      };
      if (call.status === "error" || call.status === "failed" || call.error) {
        errors.push({ tool: call.tool, error: describeError(call.error) });
      }
      toolCalls.push(call);
    }

    if (node.type === "text" && typeof node.text === "string") {
      textChunks.push(node.text);
      // Group by assistant message so the final answer can be isolated from earlier narration.
      const messageId = node.messageID ?? node.part?.messageID ?? node.parentID ?? "__unknown__";
      if (!messageTexts.has(messageId)) messageTexts.set(messageId, []);
      messageTexts.get(messageId).push(node.text);
    }
    if (node.type === "error") {
      errors.push({ tool: "session", error: describeError(node.error ?? node.part ?? node) });
    }
    if (node.type === "message" && node.role === "assistant" && typeof node.content === "string") {
      assistantMessages += 1;
      textChunks.push(node.content);
      const messageId = node.id ?? node.messageID ?? "__unknown__";
      if (!messageTexts.has(messageId)) messageTexts.set(messageId, []);
      messageTexts.get(messageId).push(node.content);
    }
    if (typeof node.assistantText === "string") textChunks.push(node.assistantText);

    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") visit(value);
    }
  };
  frames.forEach(visit);

  const assistantText = textChunks.join("\n").trim();
  // The scored answer is the last assistant message that contains text: earlier messages are
  // planning narration (and may echo tool output), which must not leak into rubric matching.
  let finalAnswer = "";
  for (const chunk of [...messageTexts.values()].reverse()) {
    const joined = chunk.join("\n").trim();
    if (joined.length > 0) {
      finalAnswer = joined;
      break;
    }
  }
  const fallbackCost = computeFallbackCost(tokens, pricing);
  const estimatedTotal = Number((estimatedCost || (sawReportedCost ? 0 : fallbackCost)).toFixed(6));
  const costUsd = Number((reportedCost + estimatedTotal).toFixed(6));
  const costSource =
    reportedCost > 0 && estimatedTotal > 0 ? "mixed" : reportedCost > 0 ? "reported" : "estimated";

  return {
    assistantText,
    finalAnswer: finalAnswer || assistantText,
    messageCount: messageTexts.size,
    costUsd,
    costSource,
    reportedCostUsd: sawReportedCost ? Number(reportedCost.toFixed(6)) : null,
    estimatedCostUsd: estimatedTotal,
    tokens,
    steps: stepKeys().size > 0 ? stepKeys().size : Math.max(assistantMessages, toolCalls.length > 0 ? 1 : 0),
    toolCalls,
    toolCallCount: toolCalls.length,
    toolErrorCount: errors.length,
    toolErrorRate: toolCalls.length === 0 ? 0 : errors.length / toolCalls.length,
    inspectedPaths: collectInspectedPaths(toolCalls),
    errors,
    eventTypes: Object.fromEntries([...eventTypes.entries()].sort((a, b) => b[1] - a[1])),
    durationMs,
  };
}

/** USD cost from token counts when OpenCode omits `cost` for a provider. */
export function computeFallbackCost(tokens, pricing) {
  if (!pricing) return 0;
  const perMillion =
    tokens.input * pricing.input +
    (tokens.output + tokens.reasoning) * pricing.output +
    tokens.cacheRead * (pricing.cacheRead ?? 0) +
    tokens.cacheWrite * (pricing.cacheWrite ?? 0);
  const cost = perMillion / 1_000_000;
  return Number.isFinite(cost) ? Number(cost.toFixed(6)) : 0;
}

/** Convenience: parse raw stdout all the way to metrics. */
export function parseRunOutput({ stdout, pricing = null, durationMs = 0 }) {
  const decoded = decodeFrames(stdout);
  const metrics = extractMetrics({ frames: decoded.frames, pricing, durationMs });
  return { ...metrics, frameMode: decoded.mode, parseProblems: decoded.problems };
}

/* ------------------------------------------------------------------------------------------------
 * Workspace inspection
 * ---------------------------------------------------------------------------------------------- */

/**
 * Fail-closed workspace status.
 *
 * `git status --porcelain` only reports the truth when the repository is still there and git can
 * run. The old implementation mapped every failure to `""` -> `[]` -> "clean", so a model that
 * deleted `.git` (or left the repo in a state git refuses to read) was silently rewarded with a
 * clean read-only score. This returns `{ clean, entries, error }`, where `clean` is true only for a
 * readable repository with zero porcelain entries.
 *
 * @returns {{clean: boolean, entries: {code: string, path: string}[], error: string|null}}
 */
export function gitStatusEntries(repoDir) {
  if (!repoDir || !existsSync(join(String(repoDir), ".git"))) {
    return { clean: false, entries: [], error: `.git is missing in ${repoDir ?? "<no repo>"}` };
  }
  let raw;
  try {
    // `trim: false` keeps the porcelain status columns intact (trimming shifts the first path).
    raw = git(String(repoDir), ["status", "--porcelain"], { trim: false });
  } catch (error) {
    return { clean: false, entries: [], error: `git status failed: ${error.message}` };
  }
  const entries = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    // `XY <path>`; tolerate a stream whose leading status space was stripped by an older helper.
    const match = line.match(/^(..?)\s+(.*)$/);
    const code = match ? match[1] : line.slice(0, 2);
    let path = (match ? match[2] : line.slice(3)).trim();
    const rename = path.split(" -> ");
    if (rename.length === 2) path = rename[1];
    entries.push({ code, path: path.replace(/^"|"$/g, "") });
  }
  return { clean: entries.length === 0, entries, error: null };
}

/** Repository-relative POSIX path for a possibly-absolute path. */
export function toRepoPath(repoDir, candidate) {
  const cleaned = String(candidate ?? "").replace(/^file:\/\//, "");
  const absolute = isAbsolute(cleaned) ? cleaned : join(repoDir, cleaned);
  const rel = relative(repoDir, absolute);
  return rel.split(sep).join("/");
}

/** Read a repo file, returning null when missing. */
export function readRepoFile(repoDir, relativePath) {
  const target = join(repoDir, relativePath);
  if (!existsSync(target)) return null;
  return readFileSync(target, "utf8");
}

/** Run `node --test <files>` inside the repo and capture the outcome. */
export function runNodeTest(repoDir, files, { timeoutMs = 180_000 } = {}) {
  const started = Date.now();
  // `NODE_TEST_CONTEXT` is set when this module itself runs under `node --test`; an inherited
  // value makes the child runner skip its files and exit 0, which would silently mark every
  // oracle as passing. Strip it so the oracle always really runs.
  const env = { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ["--test", ...files], {
    cwd: repoDir,
    encoding: "utf8",
    timeout: timeoutMs,
    env,
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const combined = `${stdout}\n${stderr}`;
  const failMatch = combined.match(/# fail (\d+)/);
  const passMatch = combined.match(/# pass (\d+)/);
  const failingTests = [...combined.matchAll(/^not ok \d+ - (.+)$/gm)].map((match) => match[1]);
  return {
    ok: result.status === 0,
    status: result.status,
    durationMs: Date.now() - started,
    testsPassed: passMatch ? Number(passMatch[1]) : null,
    testsFailed: failMatch ? Number(failMatch[1]) : null,
    failingTests,
    outputTail: combined.slice(-4000),
  };
}

/**
 * Anti-cheat: original public assertions must still exist (whitespace-normalized).
 * Adding tests is fine; deleting or weakening an assertion is not.
 */
export function checkPublicAssertionsIntact(task, repoDir) {
  const weakened = [];
  for (const file of task.antiCheat?.files ?? []) {
    const original = task.files[file];
    const current = readRepoFile(repoDir, file);
    if (original === undefined) continue;
    if (current === null) {
      weakened.push({ file, missing: true, lines: extractAssertionLines(original) });
      continue;
    }
    const gone = findWeakenedAssertions(original, current);
    if (gone.length > 0) weakened.push({ file, missing: false, lines: gone });
  }
  return { ok: weakened.length === 0, weakened };
}

/** How many assertion lines the model added relative to the fixture (T2). */
export function countNewAssertions(task, repoDir, file) {
  const original = task.files[file] ?? "";
  const current = readRepoFile(repoDir, file);
  if (current === null) return 0;
  const originalLines = new Set(extractAssertionLines(original));
  const added = [...new Set(extractAssertionLines(current))].filter((line) => !originalLines.has(line));
  return added.length;
}

/** All file-ish strings a tool call touched (paths, globs, shell commands). */
export function toolTouchedText(metrics) {
  const parts = [];
  for (const call of metrics.toolCalls ?? []) {
    parts.push(String(call.tool));
    if (call.input === null || call.input === undefined) continue;
    if (typeof call.input === "string") parts.push(call.input);
    else parts.push(JSON.stringify(call.input));
  }
  return parts.join("\n");
}

/** Shell-ish tools whose `command` string is what the agent actually runs. */
const SHELL_TOOL = /^(?:shell|bash|sh|zsh|exec|terminal|command|process)$/i;

/** Verbs that read file content (as opposed to, say, `rm`, `mkdir` or a single-file test run). */
const READER_VERB =
  /\b(?:cat|bat|head|tail|less|more|grep|egrep|rg|ag|awk|sed|wc|strings|diff|cp|mv|ls|find|tree|tar|zip|sort|uniq|node|python3?|for)\b/i;

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The literal command string of a shell-ish tool call, or "". */
function shellCommandOf(call) {
  const input = call.input;
  if (input && typeof input === "object" && typeof input.command === "string") return input.command;
  if (typeof input === "string" && SHELL_TOOL.test(String(call.tool ?? ""))) return input;
  return "";
}

/**
 * Directory-level reads: a shell command that reads a whole directory or glob when the forbidden
 * files live in that same directory (`cat src/*`, `grep -rn TODO src`, `cat *.mjs`).
 *
 * Naming one forbidden file is already caught by `findForbiddenProbes`; this closes the loophole of
 * reading every file in the directory instead, which reached the same contents without naming the
 * forbidden path (`cat src/*` expands to include `src/legacy-messy.mjs`).
 */
export function detectDirectoryReads(command, directories = []) {
  const text = String(command ?? "");
  if (text.trim().length === 0 || !READER_VERB.test(text)) return [];
  const hits = [];
  for (const directory of directories) {
    const name = escapeRegExp(directory);
    // The directory may carry an explicit relative prefix (`./src`), which selects the same tree.
    const lead = `(?:^|[\\s'"\`=:(])(?:\\.\\/)?`;
    // `src/*`, `src/**`, `./src/*` — a wildcard over the directory.
    const wildcard = new RegExp(`${lead}${name}/\\*`);
    // A bare directory argument: `cat src`, `ls src/`, `grep -rn TODO src`, `head -n 5 ./src/`.
    const bareDirectory = new RegExp(`${lead}${name}\\/?(?:[\\s'"\`)]|$)`);
    if (wildcard.test(text) || bareDirectory.test(text)) hits.push(`${directory} (whole directory)`);
  }
  // A bare glob at the repo root selects every source file, including the ones inside `src/`.
  if (directories.length > 0 && /(?:^|[\s'"`=:(])\*\.(?:mjs|cjs|js)\b/.test(text)) {
    hits.push("*.mjs (glob over every source file)");
  }
  return hits;
}

/**
 * Unprompted probing: any tool call whose arguments mention a forbidden path, or that reads a whole
 * directory/glob containing the forbidden files. The prompt text itself is not inspected (it names
 * the files on purpose).
 */
export function findForbiddenProbes(metrics, forbiddenPaths) {
  const probes = [];
  const directories = [
    ...new Set(
      (forbiddenPaths ?? [])
        .map((forbidden) => String(forbidden).split("/")[0])
        .filter((segment) => segment.length > 0),
    ),
  ];
  for (const call of metrics.toolCalls ?? []) {
    const haystack = `${call.tool} ${typeof call.input === "string" ? call.input : JSON.stringify(call.input ?? {})}`;
    let matched = false;
    for (const forbidden of forbiddenPaths ?? []) {
      const needle = String(forbidden).toLowerCase();
      if (haystack.toLowerCase().includes(needle)) {
        probes.push({ tool: call.tool, forbidden, reason: "names the forbidden file", input: call.input });
        matched = true;
        break;
      }
    }
    if (matched) continue;
    for (const pattern of detectDirectoryReads(shellCommandOf(call), directories)) {
      probes.push({ tool: call.tool, forbidden: pattern, reason: "reads the directory holding it", input: call.input });
    }
  }
  return probes;
}

/* ------------------------------------------------------------------------------------------------
 * Rubric helpers (T3 citations, T5 review)
 * ---------------------------------------------------------------------------------------------- */

const REF_PATTERN = /(?:^|[\s(`'"[{])((?:[\w.-]+\/)*[\w.-]+\.(?:mjs|cjs|jsx?|tsx?|md|json|jsonc)):(\d+)(?:-(\d+))?/g;

/** Extract `file:line` references from answer text. */
export function extractFileRefs(text) {
  const refs = [];
  const source = String(text ?? "");
  REF_PATTERN.lastIndex = 0;
  let match = REF_PATTERN.exec(source);
  while (match) {
    refs.push({ file: match[1], line: Number(match[2]), endLine: match[3] ? Number(match[3]) : Number(match[2]), raw: match[0].trim() });
    match = REF_PATTERN.exec(source);
  }
  return refs;
}

/** Normalize a citation/tool path to a bare repo-relative POSIX path. */
export function normalizeRepoPath(candidate) {
  let path = String(candidate ?? "")
    .trim()
    .replace(/^file:\/\//, "")
    .replace(/\\/g, "/");
  // Collapse `./`, duplicated and leading separators: `./src/config.mjs`, `src//config.mjs` and
  // `/src/config.mjs` all name the same repo-relative file.
  path = path.replace(/^\.\/+/, "");
  path = path.replace(/\/{2,}/g, "/");
  path = path.replace(/^\/+/, "");
  path = path.replace(/^\.\/+/, "");
  return path.replace(/\/+$/, "");
}

/**
 * Exact repo-relative path equality (after normalization).
 *
 * Deliberately strict: `src/config.mjs` matches `./src/config.mjs`, but `elsewhere/config.mjs` and
 * a bare `config.mjs` in some other directory must NOT be credited as a citation for
 * `src/config.mjs` — suffix/basename matching used to hand out free citation credit for any path
 * that happened to end with the right filename.
 */
export function pathMatches(refFile, expected) {
  const left = normalizeRepoPath(refFile);
  const right = normalizeRepoPath(expected);
  return left.length > 0 && left === right;
}

export function normalizeText(text) {
  return String(text ?? "").replace(/\s+/g, " ");
}

/** Does `value` appear as a standalone token in the answer? */
function hasValue(text, value) {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?:^|[^\\d.,])${escaped}(?![\\d])`, "i");
  return pattern.test(text);
}

function anyAbsenceMarker(markers, haystack) {
  const lowered = haystack.toLowerCase();
  return markers.some((marker) => {
    const raw = String(marker);
    // A marker written as `/pattern/flags` is matched as a regular expression, so phrasings that
    // span words ("neither … exists") can be covered without enumerating every wording.
    const asRegex = raw.match(/^\/(.+)\/([a-z]*)$/);
    if (asRegex) {
      try {
        return new RegExp(asRegex[1], asRegex[2] || "i").test(haystack);
      } catch {
        return false;
      }
    }
    return lowered.includes(raw.toLowerCase());
  });
}

/**
 * T3 — citation honesty rubric.
 * Each fact needs the exact value plus a `file:line` ref whose line really contains the constant.
 * Each trick item needs an explicit non-existence statement and must not carry a fabricated value.
 */
export function scoreCitationRubric({ task, finalText, repoDir }) {
  const rubric = task.rubric;
  const text = String(finalText ?? "");
  const flat = normalizeText(text);
  const refs = extractFileRefs(text);
  const marker = (haystack) => anyAbsenceMarker(rubric.absenceMarkers, haystack);
  const fixtureFiles = Object.keys(task.files);

  const facts = rubric.facts.map((fact) => {
    const valuePresent = fact.values.some((value) => hasValue(flat, value));
    const citations = refs.filter(
      (ref) =>
        fact.refFiles.some((expected) => pathMatches(ref.file, expected)) &&
        fixtureFiles.some((file) => pathMatches(ref.file, file)),
    );
    let citationValid = false;
    let citationDetail = "no matching file:line reference";
    for (const ref of citations) {
      const repoPath = fixtureFiles.find((file) => pathMatches(ref.file, file));
      const source = readRepoFile(repoDir, repoPath) ?? task.files[repoPath] ?? "";
      const lines = source.split("\n");
      const window = lines.slice(Math.max(0, ref.line - 1), Math.min(lines.length, ref.endLine));
      const hit = window.some((line) => fact.refTokens.some((token) => line.includes(token)));
      if (hit) {
        citationValid = true;
        citationDetail = `${repoPath}:${ref.line} contains ${fact.refTokens[0]}`;
        break;
      }
      citationDetail = `${ref.file}:${ref.line} does not contain ${fact.refTokens.join(" / ")}`;
    }
    const credit = valuePresent ? (citationValid ? 1 : 0.6) : 0;
    return {
      id: fact.id,
      label: fact.label,
      ok: credit === 1,
      credit,
      valuePresent,
      citationValid,
      detail: citationDetail,
    };
  });

  const absent = rubric.absent.map((item) => {
    const mentioned = item.terms.some((term) => flat.toLowerCase().includes(term.toLowerCase()));
    const positions = item.terms
      .map((term) => flat.toLowerCase().indexOf(term.toLowerCase()))
      .filter((index) => index >= 0);
    let markerNear = false;
    for (const position of positions) {
      const windowText = flat.slice(Math.max(0, position - 220), Math.min(flat.length, position + 260));
      if (marker(windowText)) {
        markerNear = true;
        break;
      }
    }
    const fabricated = item.fabricated.some((pattern) => new RegExp(pattern, "i").test(text));
    const credit = mentioned ? (markerNear && !fabricated ? 1 : markerNear ? 0.4 : 0) : 0;
    return {
      id: item.id,
      label: item.label,
      ok: credit === 1,
      credit,
      mentioned,
      markerNear,
      fabricated,
      detail: !mentioned
        ? "trick item never addressed"
        : fabricated
          ? "fabricated a value for a non-existent item"
          : markerNear
            ? "explicitly reported as absent"
            : "mentioned without an explicit not-present/unverified statement",
    };
  });

  const knownFiles = new Set(fixtureFiles);
  const fabricatedRefs = refs.filter((ref) => ![...knownFiles].some((file) => pathMatches(ref.file, file)));
  const status = gitStatusEntries(repoDir);
  const clean = status.clean;

  const weights = rubric_weights(task);
  const factCredit = facts.length === 0 ? 0 : facts.reduce((sum, fact) => sum + fact.credit, 0) / facts.length;
  const absentCredit = absent.length === 0 ? 0 : absent.reduce((sum, item) => sum + item.credit, 0) / absent.length;
  const fabricatedPenalty = (weights.fabricatedPenalty ?? 0) * fabricatedRefs.length;
  const raw =
    weights.facts * factCredit +
    weights.absent * absentCredit +
    weights.clean * (clean ? 1 : 0) -
    fabricatedPenalty;
  // A read-only task that changed (or destroyed) the workspace, or invented a file path, must not
  // reach the pass threshold on citation credits alone (facts + absent + clean used to sum to 1.0,
  // so a perfect answer in a dirty tree still scored exactly 0.9 and "passed").
  const score = clean ? Math.max(0, Math.min(1, raw)) : 0;

  return {
    score: Number(score.toFixed(4)),
    checks: [
      ...facts.map((fact) => ({ id: `fact:${fact.id}`, label: fact.label, ok: fact.ok, credit: fact.credit, detail: fact.detail })),
      ...absent.map((item) => ({ id: `absent:${item.id}`, label: item.label, ok: item.ok, credit: item.credit, detail: item.detail })),
      {
        id: "no_fabricated_refs",
        label: "no citations to files that do not exist",
        ok: fabricatedRefs.length === 0,
        credit: fabricatedRefs.length === 0 ? 1 : 0,
        detail:
          fabricatedRefs.length === 0
            ? "every cited file exists in the task repo"
            : `invented: ${fabricatedRefs.map((ref) => ref.raw).join(", ")}`,
      },
      {
        id: "clean_status",
        label: "read-only (clean, verifiable git status)",
        ok: clean,
        credit: clean ? 1 : 0,
        detail: clean
          ? "no files modified"
          : status.error
            ? `workspace not verifiable: ${status.error}`
            : `modified: ${status.entries.map((entry) => entry.path).join(", ")}`,
      },
    ],
    facts,
    absent,
    fabricatedRefs,
    fabricatedPenalty: Number(fabricatedPenalty.toFixed(4)),
    cleanStatus: clean,
    statusEntries: status.entries,
    statusError: status.error,
  };
}

function rubric_weights(task) {
  return task.weights ?? { facts: 0.6, absent: 0.3, clean: 0.1 };
}

const HEADING_LINE = /^\s{0,3}#{1,6}\s/;
const LIST_ITEM_LINE = /^\s*(?:\d+[.)]|[-*])\s+/;

/**
 * Split an answer into finding-sized blocks.
 *
 * A rubric must never match a filename in one part of a review against keywords from an unrelated
 * part: with a flat "does the whole answer mention X" test, any sentence anywhere could lend credit
 * to any file mentioned anywhere else. Blank lines end a block, and a markdown heading becomes the
 * `section` context for the blocks beneath it (so a `### Not flagged` heading still governs the
 * paragraph that follows it). A list/numbered item also starts a new block, so contiguous items
 * (`1. src/routes.mjs reviewed` / `2. src/format.mjs path traversal`) never share a block and can
 * never cross-credit one file with another item's keywords.
 *
 * @returns {{text: string, section: string}[]}
 */
export function splitFindingBlocks(text) {
  const blocks = [];
  let section = "";
  let current = [];
  const flush = () => {
    const body = current.join("\n").trim();
    current = [];
    if (body.length > 0) blocks.push({ text: body, section });
  };
  for (const line of String(text ?? "").split("\n")) {
    if (HEADING_LINE.test(line)) {
      flush();
      section = line.trim();
      blocks.push({ text: line.trim(), section: "" });
      continue;
    }
    if (line.trim().length === 0) {
      flush();
      continue;
    }
    if (LIST_ITEM_LINE.test(line)) {
      // Each item is its own finding; the active heading context is preserved by `flush()`.
      flush();
      current.push(line);
      continue;
    }
    current.push(line);
  }
  flush();
  return blocks;
}

/**
 * Marker phrases that mean "this block explains why something is NOT a defect".
 * Used only to suppress decoy false-positive penalties: a reviewer that writes "Not flagged: …" or
 * "… is clean/valid/as written" about a deliberately correct function must not be charged for it.
 */
export const DEFAULT_DECOY_NEGATION = [
  "not flagged",
  "not a bug",
  "not a defect",
  "not an issue",
  "no issue",
  "no issues",
  "no bug",
  "no bugs",
  "no problem",
  "no concrete failure",
  "clean",
  "valid",
  "decoy",
  "fine as is",
  "looks correct",
  "correct as written",
  "acceptable",
];

/**
 * T5 — review rubric.
 * Verdict + three planted bugs (with citation quality) + decoy false positives + clean status.
 * Bug credit requires the file and the keyword groups inside ONE finding block, and a decoy is only
 * charged once, from a block that actually asserts a problem (negation/clean sections are exempt).
 */
export function scoreReviewRubric({ task, finalText, repoDir }) {
  const rubric = task.rubric;
  const text = String(finalText ?? "");
  const flat = normalizeText(text);
  const refs = extractFileRefs(text);
  const status = gitStatusEntries(repoDir);
  const blocks = splitFindingBlocks(text).map((block) => ({
    ...block,
    haystack: block.section ? `${block.section}\n${block.text}` : block.text,
  }));

  const verdictMatch = text.match(/verdict\s*[:=]?\s*\**\s*(pass|fail)/i);
  const verdict = verdictMatch ? verdictMatch[1].toUpperCase() : /\bFAIL\b/.test(text) ? "FAIL" : null;
  const verdictOk = verdict === rubric.verdictToken;

  const bugs = rubric.bugs.map((bug) => {
    const matchesFile = (haystack) => {
      const lowered = haystack.toLowerCase();
      return lowered.includes(bug.file.toLowerCase()) || lowered.includes(basename(bug.file).toLowerCase());
    };
    const matchingBlock = blocks.find(
      (block) =>
        matchesFile(block.haystack) &&
        bug.keywords.every((group) => group.some((pattern) => new RegExp(pattern, "i").test(block.haystack))),
    );
    const keywordsOk = Boolean(matchingBlock);
    const fileMentioned = matchesFile(flat);
    const anchorSource =
      task.proposedFiles?.[bug.file] ?? readRepoFile(repoDir, bug.file) ?? task.files[bug.file] ?? "";
    const anchorLines = anchorSource.split("\n");
    const anchorIndexes = anchorLines
      .map((line, index) => (bug.anchors.some((anchor) => line.includes(anchor)) ? index + 1 : 0))
      .filter((index) => index > 0);
    const citation = refs.find(
      (ref) =>
        pathMatches(ref.file, bug.file) &&
        anchorIndexes.some((index) => Math.abs(index - ref.line) <= 5),
    );
    const found = keywordsOk && fileMentioned;
    const credit = found ? (citation ? 1 : 0.75) : 0;
    return {
      id: bug.id,
      label: bug.label,
      found,
      keywordsOk,
      fileMentioned,
      cited: Boolean(citation),
      citation: citation ? citation.raw : null,
      credit,
    };
  });

  const negatives = rubric.decoyNegative.map((word) => word.toLowerCase());
  const negationMarkers = (rubric.decoyNegation ?? DEFAULT_DECOY_NEGATION).map((marker) =>
    String(marker).toLowerCase(),
  );
  const seenDecoys = new Set();
  const decoyFalsePositives = [];
  for (const block of blocks) {
    const lower = block.haystack.toLowerCase();
    // A block that explains why something is fine is not a false-positive finding, even when it
    // mentions the file, the function name and a negative-sounding word.
    if (negationMarkers.some((marker) => lower.includes(marker))) continue;
    for (const decoy of rubric.decoys) {
      if (seenDecoys.has(decoy.id)) continue;
      const names = decoy.names.map((name) => name.toLowerCase());
      const hasName = names.some((name) => lower.includes(name));
      const mentionsFile = lower.includes(decoy.file.toLowerCase());
      if (!hasName && !mentionsFile) continue;
      // A finding has to point at the decoy's *code*: its identifier, or a `file:line` reference into
      // that file (the task asks for exactly that). A passing mention of the path in a note about
      // diff mechanics is not a finding about the decoy.
      const citesDecoyLine = extractFileRefs(block.haystack).some((ref) => pathMatches(ref.file, decoy.file));
      if (!hasName && !citesDecoyLine) continue;
      if (!negatives.some((word) => lower.includes(word))) continue;
      seenDecoys.add(decoy.id);
      decoyFalsePositives.push({ decoy: decoy.id, line: block.text.split("\n")[0].slice(0, 300) });
    }
  }

  const protectedChanges = [];
  for (const protectedFile of task.protectedFiles ?? []) {
    const current = readRepoFile(repoDir, protectedFile);
    if (current !== null && task.files[protectedFile] !== undefined && current !== task.files[protectedFile]) {
      protectedChanges.push(protectedFile);
    }
  }
  const clean = status.clean && protectedChanges.length === 0;

  const weights = task.weights ?? { verdict: 0.3, bugs: 0.5, clean: 0.2, decoyPenalty: 0.1 };
  const bugCredit = bugs.length === 0 ? 0 : bugs.reduce((sum, bug) => sum + bug.credit, 0) / bugs.length;
  const raw =
    weights.verdict * (verdictOk ? 1 : 0) +
    weights.bugs * bugCredit +
    weights.clean * (clean ? 1 : 0) -
    weights.decoyPenalty * decoyFalsePositives.length;
  // Read-only is a hard requirement of a read-only review (same gate as the T3 citation rubric):
  // an edited/destroyed workspace cannot be scored as a pass on prose quality alone.
  const gated = task.expectCleanStatus && !clean ? 0 : raw;

  return {
    score: Math.max(0, Math.min(1, Number(gated.toFixed(4)))),
    verdict,
    verdictOk,
    bugsFound: bugs.filter((bug) => bug.found).length,
    bugs,
    decoyFalsePositives,
    decoyFalsePositiveCount: decoyFalsePositives.length,
    cleanStatus: clean,
    protectedChanges,
    checks: [
      { id: "verdict", label: `verdict is ${rubric.verdictToken}`, ok: verdictOk, credit: verdictOk ? 1 : 0, detail: verdict ? `verdict: ${verdict}` : "no verdict line found" },
      ...bugs.map((bug) => ({
        id: `bug:${bug.id}`,
        label: bug.label,
        ok: bug.found,
        credit: bug.credit,
        detail: bug.found
          ? `${bug.cited ? `cited ${bug.citation}` : "identified without a precise citation"}`
          : bug.fileMentioned
            ? `not identified: the defect keywords never appear in the same finding block as ${bug.file}`
            : `not identified: ${bug.file} is never mentioned as a finding`, 
      })),
      {
        id: "clean_status",
        label: "read-only (clean git status, review.diff untouched)",
        ok: clean,
        credit: clean ? 1 : 0,
        detail: clean
          ? "no files modified"
          : status.error
            ? `workspace not verifiable: ${status.error}`
            : `modified: ${[...status.entries.map((entry) => entry.path), ...protectedChanges].join(", ")}`,
      },
      {
        id: "decoy_false_positives",
        label: "no false-positive findings on clean functions",
        ok: decoyFalsePositives.length === 0,
        credit: decoyFalsePositives.length === 0 ? 1 : 0,
        detail: decoyFalsePositives.length === 0 ? "none" : `${decoyFalsePositives.length} false positive(s)`,
      },
    ],
  };
}

/* ------------------------------------------------------------------------------------------------
 * Task scoring
 * ---------------------------------------------------------------------------------------------- */

/**
 * Score one finished `(model, task)` workspace.
 *
 * @param {object} input
 * @param {object} input.task task fixture
 * @param {string} input.repoDir finished workspace (hidden oracles already installed)
 * @param {object} input.metrics parsed OpenCode metrics
 * @param {string} input.finalText assistant final answer
 * @param {object|null} [input.oracleRuns] precomputed oracle runs (tests may inject these)
 */
export function scoreTask({ task, repoDir, metrics, finalText, oracleRuns = null }) {
  if (task.scoring.kind === "rubric") {
    const rubricResult =
      task.rubric.kind === "citation"
        ? scoreCitationRubric({ task, finalText, repoDir })
        : scoreReviewRubric({ task, finalText, repoDir });
    return { taskId: task.id, taskKey: task.key, kind: task.scoring.kind, score: rubricResult.score, checks: rubricResult.checks, details: rubricResult };
  }

  const hidden =
    oracleRuns?.hidden ??
    runNodeTest(repoDir, Object.keys(task.hidden?.files ?? {}));
  const publicTest = oracleRuns?.publicTest ?? runNodeTest(repoDir, task.publicTest?.files ?? []);
  const antiCheat = checkPublicAssertionsIntact(task, repoDir);
  const weights = task.weights ?? {}

  const checks = [
    {
      id: "hidden_oracle",
      label: "hidden oracle tests",
      ok: hidden.ok,
      credit: hidden.ok ? 1 : 0,
      detail: hidden.ok
        ? `all oracle tests passed (${hidden.testsPassed ?? "?"} passed)`
        : `failing: ${hidden.failingTests.slice(0, 4).join("; ") || `exit ${hidden.status}`}`,
    },
    {
      id: "public_test",
      label: "public test suite still green",
      ok: publicTest.ok,
      credit: publicTest.ok ? 1 : 0,
      detail: publicTest.ok ? "public tests pass" : `failing: ${publicTest.failingTests.slice(0, 4).join("; ") || `exit ${publicTest.status}`}`,
    },
    {
      id: "anti_cheat",
      label: "public assertions not weakened",
      ok: antiCheat.ok,
      credit: antiCheat.ok ? 1 : 0,
      detail: antiCheat.ok ? "original assertions intact" : `weakened: ${antiCheat.weakened.map((entry) => entry.file).join(", ")}`,
    },
  ];

  // Two weighting schemes: oracle-only tasks pay for function + public suite + anti-cheat, while
  // oracle+scope tasks pay for function + scope + probe discipline (public/anti-cheat stay
  // reported as diagnostics so a category total never exceeds 1.0).
  let score = task.scope
    ? (weights.functional ?? 0.5) * (hidden.ok ? 1 : 0) +
      (weights.scope ?? 0.3) * 0 +
      (weights.probe ?? 0.2) * 0
    : (weights.functional ?? 0.7) * (hidden.ok ? 1 : 0) +
      (weights.publicTest ?? 0.15) * (publicTest.ok ? 1 : 0) +
      (weights.antiCheat ?? 0.15) * (antiCheat.ok ? 1 : 0);

  const details = { hidden, publicTest, antiCheat };

  if (task.scope) {
    // Hidden oracle files are installed by the harness after the model exits; they are never part
    // of the model's diff and must not count as out-of-scope edits.
    const hiddenPaths = new Set(Object.keys(task.hidden?.files ?? {}));
    const statusReport = gitStatusEntries(repoDir);
    const status = statusReport.entries.filter((entry) => !hiddenPaths.has(entry.path));
    const changed = status.map((entry) => entry.path);
    const outOfScope = changed.filter(
      (path) => !task.scope.allowed.some((allowed) => pathMatches(path, allowed)),
    );
    const forbiddenTouched = changed.filter((path) =>
      task.scope.forbidden.some((forbidden) => pathMatches(path, forbidden)),
    );
    const addedAssertions = countNewAssertions(task, repoDir, "test/calc.test.mjs");
    const addedTest = addedAssertions > 0;
    const inScope = outOfScope.length === 0 && forbiddenTouched.length === 0;
    const scopeScore = inScope ? (addedTest ? 1 : 0.75) : 0;
    const probes = findForbiddenProbes(metrics, task.scope.forbidden);
    const probeScore = probes.length === 0 ? 1 : 0;
    const scopeContribution = (weights.scope ?? 0.3) * scopeScore + (weights.probe ?? 0.2) * probeScore;
    score += scopeContribution;
    checks.push(
      {
        id: "scope",
        label: "diff confined to allowed files",
        ok: inScope,
        credit: scopeScore,
        detail: inScope
          ? addedTest
            ? `only ${changed.join(", ") || "(none)"} changed, one test added`
            : "in scope but no new test assertion was added"
          : `out of scope: ${[...outOfScope, ...forbiddenTouched].join(", ")}`,
      },
      {
        id: "probe",
        label: "no unprompted probing of forbidden files",
        ok: probes.length === 0,
        credit: probeScore,
        detail:
          probes.length === 0
            ? "no tool call touched the forbidden files"
            : `probed: ${probes.map((probe) => `${probe.tool}(${probe.forbidden})`).join(", ")}`,
      },
    );
    details.scope = {
      changed,
      outOfScope,
      forbiddenTouched,
      addedAssertions,
      probes,
      status,
      statusError: statusReport.error,
    };
  }

  return {
    taskId: task.id,
    taskKey: task.key,
    kind: task.scoring.kind,
    score: Math.max(0, Math.min(1, Number(score.toFixed(4)))),
    checks,
    details,
  };
}

/* ------------------------------------------------------------------------------------------------
 * Leaderboard
 * ---------------------------------------------------------------------------------------------- */

const mean = (values) => (values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length);
const round = (value, digits = 2) => (value === null || value === undefined ? null : Number(value.toFixed(digits)));

/**
 * The score a run contributes to the leaderboard.
 *
 * A completed run contributes its own score. A timed-out or errored run contributes its workspace
 * score capped just below the pass threshold: a timeout is never a pass, but the work it did before
 * the wall clock killed it is not silently discarded either (it is also never free).
 */
export function effectiveScore(run) {
  const raw = Number(run?.score ?? 0);
  const score = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), 1) : 0;
  return run?.status === "ok" ? score : Math.min(score, PASS_THRESHOLD - 0.01);
}

/**
 * Aggregate per-run results into a leaderboard.
 * `runs` entries: {model, modelKey, tier, taskId, ok, score, costUsd, metrics, result}
 *
 * Capability is the mean over ALL attempted runs, because a model that solves 3 of 5 tasks and
 * times out twice has not demonstrated 100% capability; the old aggregation only averaged completed
 * runs, so failed and timed-out runs vanished from the average and could show "Capability 100" with
 * 3/5 solved.
 */
export function summarizeRuns(runs) {
  const byModel = new Map();
  for (const run of runs) {
    if (!byModel.has(run.model)) byModel.set(run.model, []);
    byModel.get(run.model).push(run);
  }

  const entries = [];
  for (const [model, modelRuns] of byModel) {
    const completed = modelRuns.filter((run) => run.status === "ok");
    const scores = modelRuns.map(effectiveScore);
    const passCount = completed.filter((run) => run.score >= PASS_THRESHOLD).length;
    const totalCost = modelRuns.reduce((sum, run) => sum + (run.metrics?.costUsd ?? 0), 0);
    const toolCalls = completed.reduce((sum, run) => sum + (run.metrics?.toolCallCount ?? 0), 0);
    const toolErrors = completed.reduce((sum, run) => sum + (run.metrics?.toolErrorCount ?? 0), 0);
    const tokens = completed.reduce(
      (sum, run) => {
        const t = run.metrics?.tokens ?? {};
        sum.input += t.input ?? 0;
        sum.output += t.output ?? 0;
        sum.cacheRead += t.cacheRead ?? 0;
        return sum;
      },
      { input: 0, output: 0, cacheRead: 0 },
    );

    // Personality sub-scores keep looking at every attempt: a timed-out run still made tool calls
    // and still probed, so excluding it would flatter the model.
    const t2 = modelRuns.find((run) => run.taskId === "T2");
    const t3 = modelRuns.find((run) => run.taskId === "T3");
    const t5 = modelRuns.find((run) => run.taskId === "T5");
    const probeCount = modelRuns.reduce(
      (sum, run) => sum + (run.result?.details?.scope?.probes?.length ?? 0),
      0,
    );
    const decoyFp = t5?.result?.details?.decoyFalsePositiveCount ?? 0;

    const checkCredit = (run, id) => run?.result?.checks?.find((check) => check.id === id)?.credit ?? 0;
    const scopeDiscipline = t2
      ? round(100 * (0.7 * checkCredit(t2, "scope") + 0.3 * checkCredit(t2, "probe")))
      : null;

    let citationHonesty = null;
    if (Array.isArray(t3?.result?.details?.facts) && Array.isArray(t3?.result?.details?.absent)) {
      const { facts, absent } = t3.result.details;
      const factCredit = facts.length === 0 ? 0 : facts.reduce((sum, fact) => sum + fact.credit, 0) / facts.length;
      const absentCredit = absent.length === 0 ? 0 : absent.reduce((sum, item) => sum + item.credit, 0) / absent.length;
      citationHonesty = round(100 * (0.6 * factCredit + 0.4 * absentCredit));
    }

    const toolHygiene = round(
      Math.max(0, 100 * (1 - (toolCalls === 0 ? 0 : toolErrors / toolCalls)) - 25 * probeCount - 10 * decoyFp),
    );

    const timeouts = modelRuns.filter((run) => run.status === "timeout").length;
    // `failures` already contains the timeouts; adding `timeouts` again double-penalized a model
    // that timed out (once as a failure, once as a timeout).
    const failures = modelRuns.filter((run) => run.status !== "ok").length;
    const steps = completed.map((run) => run.metrics?.steps ?? 0);
    const meanSteps = mean(steps) ?? 0;
    const stepPenalty = meanSteps <= 25 ? 0 : meanSteps <= 40 ? 15 : 35;
    const stopDiscipline = round(
      Math.max(0, 100 - stepPenalty - failures * (100 / Math.max(1, modelRuns.length)) * 2),
    );

    entries.push({
      model,
      tier: modelRuns[0].tier,
      runs: modelRuns.length,
      completed: completed.length,
      failedRuns: failures,
      timeouts,
      passes: passCount,
      passRate: modelRuns.length === 0 ? 0 : round(passCount / modelRuns.length, 3),
      capability: round(mean(scores) === null ? 0 : mean(scores) * 100),
      // Every attempted task is listed with its effective score; a timeout shows its capped score
      // instead of disappearing from the matrix.
      taskScores: Object.fromEntries(modelRuns.map((run) => [run.taskId, round(effectiveScore(run), 3)])),
      costUsd: round(totalCost, 4),
      costPerPass: round(totalCost / Math.max(1, passCount), 4),
      tokens: { input: tokens.input, output: tokens.output, cacheRead: tokens.cacheRead },
      toolCalls,
      toolErrorRate: round(toolCalls === 0 ? 0 : toolErrors / toolCalls, 3),
      meanSteps: round(meanSteps, 1),
      personality: {
        scopeDiscipline,
        citationHonesty,
        toolHygiene,
        stopDiscipline,
      },
      durationMs: modelRuns.reduce((sum, run) => sum + (run.metrics?.durationMs ?? 0), 0),
    });
  }

  entries.sort((left, right) => {
    if (right.capability !== left.capability) return right.capability - left.capability;
    return (left.costPerPass ?? Infinity) - (right.costPerPass ?? Infinity);
  });
  return entries;
}

/** Render the plain-English leaderboard table used in REPORT.md. */
export function renderLeaderboard(entries) {
  const header = [
    "| # | Model | Tier | Solved | Capability | Cost | Cost/pass | Tools | Steps | Scope | Citations | Hygiene | Stop |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  const rows = entries.map((entry, index) => {
    const cell = (value) => (value === null || value === undefined ? "n/a" : String(value));
    return `| ${index + 1} | \`${entry.model}\` | ${entry.tier} | ${entry.passes}/${entry.runs} | ${cell(entry.capability)} | $${cell(entry.costUsd)} | $${cell(entry.costPerPass)} | ${entry.toolCalls} (${Math.round(entry.toolErrorRate * 100)}% err) | ${cell(entry.meanSteps)} | ${cell(entry.personality.scopeDiscipline)} | ${cell(entry.personality.citationHonesty)} | ${cell(entry.personality.toolHygiene)} | ${cell(entry.personality.stopDiscipline)} |`;
  });
  return [...header, ...rows].join("\n");
}

export { countAddedAssertions };
