// MEMORY.md auto-consolidator plus shared, tolerant audit-JSONL readers used by the supervisor
// and the weekly RSI pruner. The memory file has a hard 2,500-character ceiling: an LLM output
// that exceeds it gets one compression retry, then deterministic section-preserving truncation.
// Writes are atomic and always back up the previous file.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  InvalidJsonError,
  createOpenRouterClientFromEnv,
  redactSecrets,
} from "./openrouter-client.mjs";

export const HARD_MEMORY_LIMIT = 2500;
export const DEFAULT_MEMORY_MODEL = "deepseek/deepseek-v4.1-flash-1017";
export const DEFAULT_MEMORY_DAYS = 14;
export const DEFAULT_MEMORY_EVENTS = 400;
const MAX_AUDIT_FILES = 500;
const MAX_AUDIT_FILE_BYTES = 8 * 1024 * 1024;
const TRUNCATION_MARKER = "\n\n_(truncated to fit the 2,500-character memory limit)_";
const EMPTY_MEMORY_FALLBACK = "# MEMORY\n\nNo verified project memory has been recorded yet.\n";

export class EmptyConsolidationError extends Error {
  constructor(message = "The consolidation model returned empty content; refusing to overwrite MEMORY.md") {
    super(message);
    this.name = "EmptyConsolidationError";
    this.code = "empty_consolidation";
  }
}

function normalizePath(value) {
  if (typeof value !== "string" || value.length === 0) return "";
  return value.replace(/\\/g, "/").replace(/\/+$/g, "");
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

/** Candidate audit directories, in priority order, without checking existence. */
export function defaultAuditDirs({ workspace = process.cwd(), env = process.env } = {}) {
  const dirs = [];
  for (const variable of ["OPENCODE_WORKFLOW_AUDIT_DIR", "OPENCODE_AUDIT_DIR"]) {
    const value = env[variable];
    if (!value) continue;
    for (const part of String(value).split(delimiter)) {
      if (part.trim()) dirs.push(resolve(part.trim()));
    }
  }
  if (workspace) {
    dirs.push(join(workspace, ".audit"));
    dirs.push(join(workspace, "artifacts", "audit"));
    dirs.push(join(workspace, "logs", "audit"));
  }
  const dataHome = env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  const configHome = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  dirs.push(join(dataHome, "opencode", "audit"));
  dirs.push(join(dataHome, "opencode", "workflow-audit"));
  // The audit plugin's own default (plugins/audit-logger/index.js: defaultAuditDir()).
  dirs.push(join(dataHome, "opencode-workflow", "audit"));
  dirs.push(join(configHome, "opencode", "audit"));
  return unique(dirs.map((dir) => resolve(dir)));
}

function walkJsonl(dir, files, depth = 0) {
  if (files.length >= MAX_AUDIT_FILES || depth > 8) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (files.length >= MAX_AUDIT_FILES) return;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      walkJsonl(full, files, depth + 1);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(full);
    }
  }
}

/** Finds JSONL audit files under the supplied directories (or files themselves). */
export function discoverAuditFiles({ dirs = [], workspace, maxFiles = MAX_AUDIT_FILES } = {}) {
  const roots = unique([...(dirs ?? []), ...defaultAuditDirs({ workspace: workspace ?? process.cwd() })]);
  const files = [];
  for (const root of roots) {
    if (files.length >= maxFiles) break;
    let info;
    try {
      info = statSync(root);
    } catch {
      continue;
    }
    if (info.isFile()) {
      if (root.endsWith(".jsonl")) files.push(root);
      continue;
    }
    if (info.isDirectory()) walkJsonl(root, files);
  }
  return unique(files).slice(0, maxFiles);
}

function entryTimestamp(entry) {
  const candidates = [
    entry?.timestamp,
    entry?.ts,
    entry?.time,
    entry?.created,
    entry?.createdAt,
    entry?.at,
    entry?.date,
    entry?.data?.timestamp,
    entry?.data?.created,
    entry?.data?.ts,
    entry?.data?.at,
  ];
  for (const value of candidates) {
    if (typeof value === "number" && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
    if (typeof value === "string" && value.trim()) {
      const numeric = Number(value);
      if (Number.isFinite(numeric) && numeric > 0) return numeric < 1e12 ? numeric * 1000 : numeric;
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function entrySession(entry) {
  return String(
    entry?.sessionID ?? entry?.sessionId ?? entry?.session?.id ?? entry?.data?.sessionID ?? entry?.data?.sessionId ?? "",
  );
}

const UNATTRIBUTED_SESSION = "unattributed";

/**
 * True when a session id names a real session. Records that carry no session at all
 * (`plugin.loaded`, `plugin.stopped`, `shell.before`) are bucketed as "unattributed"; they are
 * real activity but they are not evidence of a distinct session.
 */
export function isAttributedSession(session) {
  const value = String(session ?? "").trim().toLowerCase();
  return value !== "" && value !== UNATTRIBUTED_SESSION && value !== "unknown";
}

function entryWorkspace(entry) {
  const values = [
    entry?.workspace,
    entry?.projectPath,
    entry?.cwd,
    entry?.directory,
    entry?.location?.directory,
    entry?.data?.workspace,
    entry?.data?.cwd,
    entry?.data?.directory,
    entry?.data?.location?.directory,
    entry?.metadata?.workspace,
    entry?.metadata?.cwd,
    entry?.project?.path,
  ];
  return normalizePath(values.find((value) => typeof value === "string" && value.length > 0) ?? "");
}

/** Project identity from explicit fields only (no basename guesswork). */
function explicitProject(entry) {
  const values = [
    entry?.project,
    entry?.projectId,
    entry?.projectID,
    entry?.data?.project,
    entry?.data?.projectID,
    entry?.metadata?.project,
  ];
  return values.find((item) => typeof item === "string" && item.length > 0) ?? "";
}

function entryProject(entry) {
  const explicit = explicitProject(entry);
  if (explicit) return explicit;
  const workspace = entryWorkspace(entry);
  return workspace ? basename(workspace) : "";
}

function isAbsoluteFsPath(value) {
  return value.startsWith("/") || /^[A-Za-z]:\//u.test(value);
}

/**
 * Lexically canonical path: forward slashes, no `.`/`..`/duplicate separators, no trailing slash.
 * It is deliberately filesystem-free (no realpath), so it also works for paths that do not exist
 * yet and for audit records describing other machines.
 */
export function canonicalPath(value) {
  const normalized = normalizePath(value);
  if (!normalized) return "";
  const absolute = isAbsoluteFsPath(normalized);
  const parts = [];
  for (const segment of normalized.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
      else if (!absolute) parts.push("..");
      continue;
    }
    parts.push(segment);
  }
  return `${absolute ? "/" : ""}${parts.join("/")}`;
}

/**
 * Membership test between a candidate path and the workspace being read.
 *
 * Two *distinct absolute* paths match only by exact canonical equality or by child-path
 * containment: `/work/alice/shared` and `/work/bob/shared` are different projects that merely
 * share a basename, and treating them as one project would attribute another team's tool calls
 * (and any secrets they touch) to this project's memory and RSI proposals.
 *
 * An absolute/relative mismatch fails closed. A bare label such as `shared` carries no absolute
 * identity at all, so it cannot be proven to be `/work/alice/shared` rather than
 * `/work/bob/shared` (or any other workspace with that basename): basename equality is only
 * meaningful when *both* sides are relative, where there is nothing better to compare.
 */
export function pathMatchesWorkspace(candidate, workspace) {
  if (!candidate || !workspace) return false;
  const left = canonicalPath(candidate);
  const right = canonicalPath(workspace);
  if (!left || !right) return false;
  if (left === right) return true;
  if (right === "/") return isAbsoluteFsPath(left);
  if (left.startsWith(`${right}/`)) return true;
  if (right.startsWith(`${left}/`)) return false;
  // Absolute vs relative (or bare label) is never evidence of the same workspace, and two distinct
  // absolute paths are different workspaces even when they share a basename.
  if (isAbsoluteFsPath(left) !== isAbsoluteFsPath(right)) return false;
  if (isAbsoluteFsPath(left)) return false;
  return basename(left) === basename(right);
}

/**
 * Membership test for one audit record, using its own workspace/project when it has one and
 * the attribution inferred from its session otherwise. `plugin.loaded` and every
 * `session.*`/`permission.*` event carry `location.directory`; `tool.*` and `shell.before`
 * records carry none, so they are attributed through the session that produced them.
 */
function matchesWorkspace({ candidate, project, sourceFile }, workspace) {
  if (!workspace) return true;
  if (candidate) return pathMatchesWorkspace(candidate, workspace);
  if (sourceFile && pathMatchesWorkspace(sourceFile, workspace)) return true;
  // A bare project label is only evidence when the workspace is not a filesystem path: two
  // distinct absolute workspaces may legitimately share a basename, so label equality alone must
  // never attribute a record to one of them.
  if (!isAbsoluteFsPath(canonicalPath(workspace))) return Boolean(project) && project === basename(workspace);
  return false;
}

function readJsonlFile(file, onBadLine) {
  let text;
  try {
    if (statSync(file).size > MAX_AUDIT_FILE_BYTES) return [];
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const entries = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") entries.push(parsed);
      else onBadLine?.();
    } catch {
      onBadLine?.();
    }
  }
  return entries;
}

/**
 * Session -> workspace/project attribution table.
 *
 * The Wave 2B plugin records `location.directory` on `plugin.loaded` and on every forwarded
 * `session.*`/`permission.*` event, but `tool.before`, `tool.after` and `shell.before` carry only
 * a session id (shell records only a cwd). Without this pass, a workspace-scoped read would drop
 * every tool call and every session id would be reported as "unknown".
 */
export function buildSessionAttribution(entries) {
  const workspaces = new Map();
  const projects = new Map();
  for (const entry of entries) {
    const session = entrySession(entry);
    if (!session) continue;
    if (!workspaces.has(session)) {
      const workspace = entryWorkspace(entry);
      if (workspace) workspaces.set(session, workspace);
    }
    if (!projects.has(session)) {
      const project = explicitProject(entry);
      if (project) projects.set(session, project);
    }
  }
  return { workspaces, projects };
}

/**
 * Reads audit entries.
 *
 * `workspace` scopes entries to one project; omit it to read all projects (the RSI pruner does
 * this). Entries without a timestamp are treated as undated and kept, because older audit
 * formats may omit it; `days` only filters entries that do carry a timestamp.
 */
export function readAuditEntries({
  dirs = [],
  workspace,
  days = DEFAULT_MEMORY_DAYS,
  now = Date.now(),
  maxEvents = null,
  includeUndated = true,
} = {}) {
  const files = discoverAuditFiles({ dirs, workspace });
  const cutoff = Number.isFinite(Number(days)) && Number(days) > 0
    ? Number(now) - Number(days) * 86_400_000
    : -Infinity;
  let skippedLines = 0;
  const raw = [];

  for (const file of files) {
    const rows = readJsonlFile(file, () => { skippedLines += 1; });
    for (const entry of rows) raw.push({ entry, file });
  }

  const attribution = buildSessionAttribution(raw.map((item) => item.entry));
  const collected = [];

  for (const { entry, file } of raw) {
    const timestamp = entryTimestamp(entry);
    if (timestamp === null && !includeUndated) continue;
    if (timestamp !== null && timestamp < cutoff) continue;
    const session = entrySession(entry);
    const ownWorkspace = entryWorkspace(entry);
    const candidate = ownWorkspace || (session ? attribution.workspaces.get(session) ?? "" : "");
    const project =
      explicitProject(entry) ||
      (session ? attribution.projects.get(session) ?? "" : "") ||
      (candidate ? basename(candidate) : "");
    if (!matchesWorkspace({ candidate, project, sourceFile: file }, workspace)) continue;
    collected.push({
      ...entry,
      __timestamp: timestamp,
      __sourceFile: file,
      __project: project || (workspace ? basename(workspace) : "unknown"),
      __session: session,
    });
  }

  collected.sort((a, b) => (a.__timestamp ?? 0) - (b.__timestamp ?? 0));
  const entries = Number.isFinite(maxEvents) && maxEvents > 0
    ? collected.slice(-Math.floor(maxEvents))
    : collected;
  return { entries, files, skippedLines, totalMatching: collected.length };
}

function typeOf(entry) {
  return String(
    entry?.type ?? entry?.event ?? entry?.kind ?? entry?.name ?? entry?.data?.type ?? "",
  ).toLowerCase();
}

function isErrorEntry(entry, type = typeOf(entry)) {
  if (/failed|failure|error|exception|interrupted/.test(type)) return true;
  if (entry?.error || entry?.errorMessage || entry?.data?.error) return true;
  const outcome = String(entry?.outcome ?? entry?.status ?? entry?.data?.outcome ?? "").toLowerCase();
  return outcome === "error" || outcome === "failed" || outcome === "failure";
}

/**
 * Tool-call identity. The audit plugin stamps the same `callId` on `tool.before` and the matching
 * `tool.after`, so pairing them counts one call instead of two.
 */
export function toolCallId(entry) {
  const value = entry?.callId ?? entry?.toolCallId ?? entry?.data?.callId ?? entry?.data?.toolCallId;
  return typeof value === "string" && value ? value : "";
}

/** `tool.before` announces a call; the matching `tool.after` is that call's terminal record. */
export function isToolStartType(type) {
  return /\.(before|started)$/.test(type);
}

export function isToolTerminalType(type) {
  return /\.(after|completed|failed)$/.test(type);
}

/** The evaluated permission outcome: an evaluate `effect`, a decision, or a prompt `reply`. */
export function permissionDecisionRef(entry) {
  const value =
    entry?.effect ?? entry?.decision ?? entry?.reply ??
    entry?.data?.effect ?? entry?.data?.decision ?? entry?.data?.reply;
  return typeof value === "string" ? value : "";
}

function toolName(entry, type) {
  const value = entry?.tool ?? entry?.toolName ?? entry?.data?.tool ?? entry?.data?.toolName ?? entry?.data?.name;
  if (typeof value === "string" && value) return value;
  if (type.startsWith("tool.") || type === "tool" || type.includes(".tool.") || type === "session.tool.called") return String(entry?.name ?? entry?.data?.id ?? "tool");
  return "";
}

function skillName(entry) {
  const value = entry?.skill ?? entry?.skillId ?? entry?.data?.skill ?? entry?.data?.skillId ?? entry?.data?.name;
  return typeof value === "string" && value ? value : "";
}

function fileRef(entry) {
  const value =
    entry?.file ?? entry?.filePath ?? entry?.path ??
    entry?.input?.filePath ?? entry?.input?.path ?? entry?.data?.file ?? entry?.data?.filePath ?? entry?.data?.path;
  return typeof value === "string" && value ? value : "";
}

function commandRef(entry) {
  const value =
    entry?.command ?? entry?.input?.command ?? entry?.data?.command ?? entry?.data?.input?.command ??
    entry?.arguments?.command;
  return typeof value === "string" ? value : "";
}

function modelRef(entry) {
  const value =
    entry?.model ?? entry?.modelID ?? entry?.modelId ?? entry?.data?.model ?? entry?.data?.modelID ??
    entry?.data?.modelId;
  if (typeof value === "string" && value) return value;
  // OpenCode forwards the compaction model as an object ({ providerID, modelID }) or as an id.
  if (value && typeof value === "object") {
    const provider = value.providerID ?? value.provider ?? entry?.providerID ?? entry?.data?.providerID;
    const id = value.modelID ?? value.modelId ?? value.id ?? value.model;
    if (typeof id === "string" && id) {
      return typeof provider === "string" && provider ? `${provider}/${id}` : id;
    }
  }
  const provider = entry?.providerID ?? entry?.data?.providerID;
  const id = entry?.modelID ?? entry?.data?.modelID ?? entry?.modelId ?? entry?.data?.modelId;
  if (typeof id === "string" && id) {
    return typeof provider === "string" && provider ? `${provider}/${id}` : id;
  }
  return "";
}

function costRef(entry) {
  const value =
    entry?.cost ?? entry?.costUSD ?? entry?.usd ?? entry?.usage?.cost ?? entry?.data?.cost ?? entry?.data?.usage?.cost;
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

/** Compact, deterministic telemetry summary used in the consolidation prompt. */
export function summarizeAuditEntries(entries, { maxSessions = 24, maxActionsPerSession = 10 } = {}) {
  const sessions = new Map();
  const global = {
    entries: entries.length,
    projects: new Set(),
    sessions: new Set(),
    toolCalls: 0,
    toolErrors: 0,
    models: new Map(),
    skillsUsed: new Set(),
    files: new Set(),
    commands: new Set(),
    permissionBlocks: 0,
  };

  // A real audit log holds `tool.before` *and* `tool.after` for the same callId. Counting both
  // would double every tool call and halve the reported error rate, so the terminal record wins.
  const completedCalls = new Set();
  for (const entry of entries) {
    if (!isToolTerminalType(typeOf(entry))) continue;
    const callId = toolCallId(entry);
    if (callId) completedCalls.add(callId);
  }

  for (const entry of entries) {
    const type = typeOf(entry);
    const project = entry.__project || entryProject(entry) || "unknown";
    const sessionID = entry.__session || entrySession(entry) || UNATTRIBUTED_SESSION;
    global.projects.add(project);
    if (isAttributedSession(sessionID)) global.sessions.add(sessionID);
    let session = sessions.get(sessionID);
    if (!session) {
      session = {
        id: sessionID,
        project,
        first: entry.__timestamp ?? null,
        last: entry.__timestamp ?? null,
        tools: 0,
        errors: 0,
        cost: 0,
        model: "",
        actions: [],
        files: new Set(),
        commands: new Set(),
      };
      sessions.set(sessionID, session);
    }
    if (entry.__timestamp) session.last = entry.__timestamp;

    const tool = toolName(entry, type);
    const isTool = tool || type.includes("tool");
    const error = isErrorEntry(entry, type);
    const callId = toolCallId(entry);
    const supersededStart = Boolean(callId) && isToolStartType(type) && completedCalls.has(callId);
    if (isTool && !supersededStart) {
      session.tools += 1;
      global.toolCalls += 1;
      if (error) {
        session.errors += 1;
        global.toolErrors += 1;
      }
      const detail = tool ? `tool:${tool}` : `tool:${entry?.name ?? "unknown"}`;
      if (session.actions.length < maxActionsPerSession) {
        session.actions.push(error ? `${detail} FAILED` : detail);
      }
    }

    const model = modelRef(entry);
    if (model) {
      session.model = model;
      const modelStat = global.models.get(model) ?? { turns: 0, cost: 0, errors: 0 };
      modelStat.turns += 1;
      modelStat.cost += costRef(entry);
      if (error) modelStat.errors += 1;
      global.models.set(model, modelStat);
    }
    session.cost += costRef(entry);

    const skill = skillName(entry);
    if (skill && /skill/.test(type)) global.skillsUsed.add(skill);

    const file = fileRef(entry);
    if (file) {
      global.files.add(file);
      session.files.add(file);
    }
    const command = commandRef(entry);
    if (command) {
      global.commands.add(command);
      session.commands.add(command);
    }

    const permissionBlocked = /permission/.test(type) &&
      /deny|denied|blocked|reject/.test(`${permissionDecisionRef(entry)} ${type}`);
    if (permissionBlocked) global.permissionBlocks += 1;

    if (/compaction/.test(type) && session.actions.length < maxActionsPerSession) {
      session.actions.push(`compaction:${entry?.status ?? "event"}`);
    }
  }

  const orderedSessions = [...sessions.values()]
    .filter((session) => isAttributedSession(session.id))
    .sort((a, b) => (b.last ?? 0) - (a.last ?? 0))
    .slice(0, maxSessions)
    .map((session) => ({
      id: session.id,
      project: session.project,
      tools: session.tools,
      errors: session.errors,
      costUSD: Number(session.cost.toFixed(4)),
      model: session.model,
      files: [...session.files].slice(0, 8),
      commands: [...session.commands].slice(0, 5),
      actions: session.actions,
    }));

  return {
    global: {
      entries: global.entries,
      projects: [...global.projects].sort(),
      sessions: global.sessions.size,
      toolCalls: global.toolCalls,
      toolErrors: global.toolErrors,
      errorRate: global.toolCalls ? global.toolErrors / global.toolCalls : 0,
      permissionBlocks: global.permissionBlocks,
      skillsUsed: [...global.skillsUsed].sort(),
      models: [...global.models.entries()]
        .map(([model, stat]) => ({ model, turns: stat.turns, costUSD: Number(stat.cost.toFixed(4)), errors: stat.errors }))
        .sort((a, b) => b.turns - a.turns),
      files: [...global.files].slice(0, 20),
      commands: [...global.commands].slice(0, 15),
    },
    sessions: orderedSessions,
  };
}

function renderSummary(summary) {
  const lines = [];
  lines.push(`Entries: ${summary.global.entries}; projects: ${summary.global.projects.join(", ") || "none"}; sessions: ${summary.global.sessions}`);
  lines.push(`Tool calls: ${summary.global.toolCalls}; failures: ${summary.global.toolErrors}; permission blocks: ${summary.global.permissionBlocks}`);
  if (summary.global.models.length) {
    lines.push(`Models: ${summary.global.models.map((m) => `${m.model} (${m.turns} turns, $${m.costUSD}, ${m.errors} errors)`).join("; ")}`);
  }
  if (summary.sessions.length) {
    lines.push("Recent sessions:");
    for (const session of summary.sessions) {
      const parts = [`- ${session.id} [${session.project}] tools=${session.tools} errors=${session.errors} cost=$${session.costUSD}`];
      if (session.model) parts.push(`model=${session.model}`);
      if (session.files.length) parts.push(`files=${session.files.join(",")}`);
      if (session.commands.length) parts.push(`commands=${session.commands.join(" | ")}`);
      if (session.actions.length) parts.push(`actions=${session.actions.join(",")}`);
      lines.push(parts.join(" "));
    }
  }
  return lines.join("\n");
}

function extractModelText(result) {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return "";
  if (typeof result.text === "string") return result.text;
  if (typeof result.content === "string") return result.content;
  if (typeof result.data?.text === "string") return result.data.text;
  if (typeof result.data?.content === "string") return result.data.content;
  if (typeof result.message?.content === "string") return result.message.content;
  return "";
}

async function callModelText(llm, request) {
  if (!llm) throw new Error("No consolidation model supplied (pass `llm` or set OPENROUTER_API_KEY)");
  let result;
  if (typeof llm === "function") result = await llm(request);
  else if (typeof llm.chat === "function") result = await llm.chat(request);
  else if (typeof llm.generate === "function") result = await llm.generate(request);
  else throw new Error("The consolidation model must be a function or expose chat()/generate()");
  const text = extractModelText(result);
  if (text.trim().length === 0) throw new EmptyConsolidationError();
  return text;
}

/** Strips accidental markdown fences around a whole MEMORY.md document. */
export function normalizeMemoryMarkdown(text) {
  let value = String(text ?? "").replace(/^\uFEFF/, "").trim();
  if (value.startsWith("```")) {
    const firstNewline = value.indexOf("\n");
    if (firstNewline !== -1) value = value.slice(firstNewline + 1);
    const closing = value.lastIndexOf("```");
    if (closing !== -1) value = value.slice(0, closing);
    value = value.trim();
  }
  return value;
}

function sliceCodePoints(text, limit) {
  if (limit <= 0) return "";
  const points = Array.from(text);
  return points.length <= limit ? text : points.slice(0, limit).join("");
}

function trimToLineBoundary(text, limit) {
  if (Array.from(text).length <= limit) return text;
  const sliced = sliceCodePoints(text, limit);
  const lastNewline = sliced.lastIndexOf("\n");
  const candidate = lastNewline > limit * 0.5 ? sliced.slice(0, lastNewline) : sliced;
  return candidate.replace(/[\s,;:\-]+$/u, "").trimEnd();
}

/**
 * Deterministically truncates markdown to `maxChars` while preferring whole `##` sections.
 * The result is always non-empty and never exceeds the character ceiling.
 */
export function truncatePreservingSections(content, maxChars = HARD_MEMORY_LIMIT) {
  const limit = Math.max(1, Math.floor(Number(maxChars) || HARD_MEMORY_LIMIT));
  const text = normalizeMemoryMarkdown(content);
  if (Array.from(text).length <= limit) return text;
  if (limit < 40) return sliceCodePoints(text, limit).trim() || sliceCodePoints(EMPTY_MEMORY_FALLBACK, limit);

  const marker = TRUNCATION_MARKER.slice(0, Math.max(0, Math.min(TRUNCATION_MARKER.length, Math.floor(limit / 4))));
  const budget = Math.max(1, limit - Array.from(marker).length);

  const sections = text.split(/\n(?=##\s)/u);
  let output = "";
  if (sections.length === 1) {
    output = trimToLineBoundary(text, budget);
  } else {
    for (const section of sections) {
      const candidate = output ? `${output}\n${section}` : section;
      if (Array.from(candidate).length <= budget) {
        output = candidate;
        continue;
      }
      // Keep the first section even if it alone is too large; truncate it cleanly.
      if (!output) output = trimToLineBoundary(section, budget);
      break;
    }
  }

  output = output.trimEnd();
  if (!output) output = trimToLineBoundary(text, budget);
  let result = `${output}${marker}`;
  if (Array.from(result).length > limit) result = trimToLineBoundary(result, limit);
  if (result.trim().length === 0) result = sliceCodePoints(EMPTY_MEMORY_FALLBACK, limit);
  return result;
}

function clampMaxChars(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return HARD_MEMORY_LIMIT;
  return Math.max(1, Math.min(HARD_MEMORY_LIMIT, Math.floor(numeric)));
}

function buildConsolidationMessages({ project, workspace, existingMemory, summary, maxChars, model }) {
  const system = [
    "You are the System-1 memory consolidator for a coding-agent project.",
    "Produce an updated MEMORY.md that is dense, factual, and useful to the next session.",
    "Keep only verified decisions, current state, open issues, and durable evidence.",
    "Do not invent facts, do not include secrets, and do not include a preamble or code fence.",
    `HARD LIMIT: at most ${maxChars} characters. Shorter is better.`,
    "Preserve these sections when they have content: # MEMORY, ## Goal, ## Decisions, ## Current state, ## Open issues, ## Verified evidence.",
  ].join("\n");
  const user = [
    `Project: ${project}`,
    `Workspace: ${workspace}`,
    `Consolidation model: ${model}`,
    `Character budget: ${maxChars}`,
    "",
    "Existing MEMORY.md (may be empty):",
    existingMemory.trim() || "(none)",
    "",
    "Audit telemetry (recent window):",
    renderSummary(summary),
    "",
    "Write the complete replacement MEMORY.md now. No commentary.",
  ].join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

function buildCompressionMessages({ current, maxChars }) {
  return [
    {
      role: "system",
      content: [
        "Compress the supplied MEMORY.md to fit the hard character ceiling.",
        "Preserve headings and the most decision-relevant facts; drop redundancy and prose.",
        `The output must be at most ${maxChars} characters and must not be empty.`,
        "Return only the markdown document, with no code fence.",
      ].join("\n"),
    },
    {
      role: "user",
      content: `Hard limit: ${maxChars} characters.\n\nCurrent document (${Array.from(current).length} chars):\n${current}\n\nReturn the compressed document.`,
    },
  ];
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
 * Consolidates audit telemetry and existing MEMORY.md into a bounded replacement.
 *
 * @param {object} options
 * @param {string} [options.workspace=process.cwd()]
 * @param {string} [options.project] Project name (defaults to the workspace basename).
 * @param {string[]} [options.auditDirs]
 * @param {string} [options.memoryPath]
 * @param {number} [options.days=14]
 * @param {number} [options.maxEvents=400]
 * @param {number} [options.maxChars=2500] Silently capped at HARD_MEMORY_LIMIT.
 * @param {string} [options.model]
 * @param {Function|object} options.llm Function or object with chat()/generate().
 * @param {boolean} [options.dryRun=false]
 * @param {number} [options.now=Date.now()]
 */
export async function consolidateMemory(options = {}) {
  const workspace = resolve(options.workspace ?? process.cwd());
  const project = options.project || basename(workspace);
  const memoryPath = resolve(options.memoryPath ?? join(workspace, "MEMORY.md"));
  const maxChars = clampMaxChars(options.maxChars ?? HARD_MEMORY_LIMIT);
  const model = options.model ?? DEFAULT_MEMORY_MODEL;
  const dryRun = Boolean(options.dryRun);
  const auditDirs = options.auditDirs ?? (options.auditDir ? [options.auditDir] : []);

  const existingMemory = existsSync(memoryPath) ? readFileSync(memoryPath, "utf8") : "";
  const scan = readAuditEntries({
    dirs: auditDirs,
    workspace,
    days: options.days ?? DEFAULT_MEMORY_DAYS,
    now: options.now ?? Date.now(),
    maxEvents: options.maxEvents ?? DEFAULT_MEMORY_EVENTS,
  });
  const summary = summarizeAuditEntries(scan.entries);
  const messages = buildConsolidationMessages({
    project,
    workspace,
    existingMemory,
    summary,
    maxChars,
    model,
  });

  const llm = options.llm ?? (options.apiKey || process.env.OPENROUTER_API_KEY
    ? createOpenRouterClientFromEnv({ model, fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs })
    : null);
  if (!llm) {
    throw new Error("No consolidation model supplied (pass `llm` or set OPENROUTER_API_KEY)");
  }

  let attempt = await callModelText(llm, {
    purpose: "consolidate",
    model,
    messages,
    maxTokens: Math.ceil(maxChars / 2),
  });
  let content = normalizeMemoryMarkdown(attempt);
  if (!content) throw new EmptyConsolidationError();

  let status = "llm";
  if (Array.from(content).length > maxChars) {
    status = "compressed";
    try {
      const retry = await callModelText(llm, {
        purpose: "compress",
        model,
        messages: buildCompressionMessages({ current: content, maxChars }),
        maxTokens: Math.ceil(maxChars / 2),
      });
      const compressed = normalizeMemoryMarkdown(retry);
      if (compressed) content = compressed;
    } catch {
      // A failed compression retry falls through to deterministic truncation.
    }
    if (Array.from(content).length > maxChars) status = "truncated";
    content = truncatePreservingSections(content, maxChars);
  }

  if (!content.trim()) content = truncatePreservingSections(EMPTY_MEMORY_FALLBACK, maxChars);
  if (!content.trim()) throw new EmptyConsolidationError();
  // Final belt-and-braces guarantee, regardless of what a malicious model returned.
  content = truncatePreservingSections(content, maxChars);

  const result = {
    project,
    workspace,
    memoryPath,
    content,
    characters: Array.from(content).length,
    maxChars,
    status,
    written: false,
    backupPath: null,
    dryRun,
    auditFiles: scan.files,
    auditEntries: scan.entries.length,
    summary,
  };

  if (dryRun) return result;

  // Backup on existence, not on content truthiness: a deliberately truncated (0-byte) MEMORY.md
  // is still prior state that the operator may need to recover, so it must be preserved.
  if (existsSync(memoryPath)) {
    const backupPath = `${memoryPath}.bak`;
    copyFileSync(memoryPath, backupPath);
    result.backupPath = backupPath;
  }
  atomicWrite(memoryPath, content);
  result.written = true;
  return result;
}

export function readMemoryContext(memoryPath, maxChars = HARD_MEMORY_LIMIT) {
  if (!memoryPath || !existsSync(memoryPath)) return "";
  return sliceCodePoints(readFileSync(memoryPath, "utf8"), clampMaxChars(maxChars));
}

function parseCliArgs(argv) {
  const options = { auditDirs: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${arg} requires a value`);
      return argv[i];
    };
    if (arg === "--workspace") options.workspace = next();
    else if (arg === "--project") options.project = next();
    else if (arg === "--audit-dir") options.auditDirs.push(next());
    else if (arg === "--memory") options.memoryPath = next();
    else if (arg === "--days") options.days = Number(next());
    else if (arg === "--max-events") options.maxEvents = Number(next());
    else if (arg === "--max-chars") options.maxChars = Number(next());
    else if (arg === "--model") options.model = next();
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
    console.log("Usage: node src/memory-consolidate.mjs [--workspace DIR] [--audit-dir DIR]... [--memory FILE] [--days N] [--max-events N] [--max-chars N] [--model ID] [--dry-run]");
    return;
  }
  const result = await consolidateMemory(options);
  if (options.dryRun) process.stdout.write(`${result.content}\n`);
  else console.log(`Updated ${result.memoryPath} (${result.characters} chars, ${result.status}, backup: ${result.backupPath ?? "none"})`);
}

if (isMainModule()) {
  main().catch((error) => {
    const message = redactSecrets(error?.message ?? error, process.env.OPENROUTER_API_KEY);
    console.error(`memory-consolidate: ${message}`);
    process.exitCode = 1;
  });
}

export const MEMORY_INTERNALS = Object.freeze({
  normalizePath,
  canonicalPath,
  pathMatchesWorkspace,
  matchesWorkspace,
  sliceCodePoints,
  renderSummary,
  entryTimestamp,
  entryWorkspace,
  entryProject,
  explicitProject,
  isToolStartType,
  isToolTerminalType,
});
