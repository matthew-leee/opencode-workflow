/**
 * opencode-workflow core plugin — OpenCode v2 (`@opencode/plugin@2.3.2`).
 *
 * Wave 1 Core Plugin Foundation:
 *   1. Deduplicated, secret-redacted append-only JSONL audit logger with process-wide
 *      single event subscription + `eventID` LRU dedupe + `location`/`model` enrichment.
 *   2. Structured JS shell & secret permission evaluator (`permission.hook("evaluate")`).
 *   3. Per-root-session Main <-> Subagent Shared Blackboard (`/tmp/opencode/blackboard/<rootSessionID>/`,
 *      0700/0600): auto-materializes inline user attachments, tracks sibling reports / file
 *      ownership / failed attempts, injects a compact pointer into subagent spawns, and
 *      validates empty/malformed child returns with real `git status --short` evidence.
 *
 * Design constraints, in order of priority:
 *   1. The plugin must never break OpenCode. Every hook, event handler and write is
 *      wrapped: failures never propagate out of setup/hooks/cleanup.
 *   2. No secret reaches disk. Tool inputs, shell commands, permission resources,
 *      blackboard reports, and event payloads pass through deep redaction;
 *      `shell.create.before` never touches `env` values at all.
 *   3. Log volume and in-memory tables are strictly bounded.
 *
 * Host resolution: `Host.resolve` loads a local directory that has a `package.json`
 * without an `exports` map through its conventional entrypoint, so this file is the
 * plugin entrypoint (`main: index.js`).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Plugin } from '@opencode/plugin';

import {
  BLACKBOARD_DIR_ENV,
  BLACKBOARD_MARKER,
  collectWorkspaceFallbackState,
  createBlackboardManager,
  extractBackgroundSubagentResults,
  extractSubagentResultInfo,
  isSensitiveAttachmentName,
  resolveBlackboardRoot,
  validateSubagentOutput,
} from './blackboard.js';
import {
  DEFAULT_MEMORY_REFRESH_CONFIG,
  createMemoryRefresher,
  isEligibleMemoryWorkspace,
} from './memory-refresh.js';
import {
  classifyEnvReference,
  evaluatePermissionInput,
  evaluateShellCommand,
  parseShellSegments,
} from './permission-guard.js';
import {
  DEFAULT_GUARD_CONFIG,
  GUARD_ACTIONS,
  assertNotTerra,
  buildRotationHandoffPrompt,
  createReactiveGuard,
  detectOscillatingEdits,
  deterministicFallbackDecision,
  isBannedModel,
  isReviewerRejectionText,
  judgeTripwire,
  normalizeErrorSignature,
  normalizeGuardDecision,
  resolveGuardConfig,
} from './reactive-guard.js';
import { REDACTED, redact, redactString } from './redact.js';
import {
  BoundedMetaMap,
  BoundedSeenSet,
  MAX_SEEN_EVENT_IDS,
  formatModelRef,
  getSharedBus,
  resetSharedBusForTests,
} from './shared-bus.js';

export {
  BLACKBOARD_DIR_ENV,
  BLACKBOARD_MARKER,
  BoundedMetaMap,
  BoundedSeenSet,
  DEFAULT_GUARD_CONFIG,
  DEFAULT_MEMORY_REFRESH_CONFIG,
  GUARD_ACTIONS,
  MAX_SEEN_EVENT_IDS,
  REDACTED,
  assertNotTerra,
  buildRotationHandoffPrompt,
  classifyEnvReference,
  collectWorkspaceFallbackState,
  createBlackboardManager,
  createMemoryRefresher,
  createReactiveGuard,
  detectOscillatingEdits,
  deterministicFallbackDecision,
  evaluatePermissionInput,
  evaluateShellCommand,
  extractBackgroundSubagentResults,
  extractSubagentResultInfo,
  formatModelRef,
  getSharedBus,
  isBannedModel,
  isEligibleMemoryWorkspace,
  isReviewerRejectionText,
  isSensitiveAttachmentName,
  judgeTripwire,
  normalizeErrorSignature,
  normalizeGuardDecision,
  parseShellSegments,
  redact,
  redactString,
  resetSharedBusForTests,
  resolveBlackboardRoot,
  resolveGuardConfig,
  validateSubagentOutput,
};

export const PLUGIN_ID = 'opencode-workflow-audit';
export const AUDIT_DIR_ENV = 'OPENCODE_WORKFLOW_AUDIT_DIR';
/** Max tool calls whose start time is remembered (oldest evicted first). */
export const MAX_PENDING_CALLS = 2000;
/** A serialized record longer than this is replaced with a truncation marker. */
export const MAX_LINE_CHARS = 64_000;
/** Bound on one hook registration's dispose() during teardown. */
export const DISPOSE_TIMEOUT_MS = 1_500;
/** Audit directory / file modes enforced (and verified) before anything is written. */
export const AUDIT_DIR_MODE = 0o700;
export const AUDIT_FILE_MODE = 0o600;

const DISPOSE_TIMEOUT = Symbol('dispose-timeout');

const PROMPT_PREVIEW_CHARS = 500;
const RESULT_PREVIEW_CHARS = 500;
const COMPACTION_PREVIEW_CHARS = 200;
const ERROR_MESSAGE_CHARS = 1000;
const MAX_LISTED_ITEMS = 50;
const FILE_MUTATION_TOOLS = new Set(['edit', 'write', 'patch', 'apply_patch']);

/**
 * Event types consumed by the shared background subscriber. Kept as an explicit list so the
 * subscription is bounded and stable: OpenCode only forwards what is asked for.
 */
export const EVENT_TYPES = [
  'session.execution.started',
  'session.execution.succeeded',
  'session.execution.failed',
  'session.execution.interrupted',
  'session.usage.updated',
  'session.idle',
  'session.compaction.started',
  'session.compaction.ended',
  'session.compaction.failed',
  'session.compaction.delta',
  'permission.asked',
  'permission.replied',
];

/** Default audit directory, used when `OPENCODE_WORKFLOW_AUDIT_DIR` is unset/empty. */
export function defaultAuditDir() {
  return path.join(os.homedir(), '.local/share/opencode-workflow/audit');
}

/** Resolve the audit directory from an environment bag (injectable for tests). */
export function resolveAuditDir(env = process.env) {
  const configured = env?.[AUDIT_DIR_ENV];
  if (typeof configured === 'string' && configured.trim().length > 0) {
    return path.resolve(configured.trim());
  }
  return defaultAuditDir();
}

function safeRead(object, key) {
  try {
    return object?.[key];
  } catch {
    return undefined;
  }
}

function safeInstanceOf(value, constructor) {
  try {
    return value instanceof constructor;
  } catch {
    // Revoked Proxy objects throw from `instanceof`.
    return false;
  }
}

/** Safe one-line description of an unknown thrown value; never throws. */
export function describeError(error) {
  try {
    if (safeInstanceOf(error, Error)) {
      return redactString(`${safeRead(error, 'name')}: ${safeRead(error, 'message')}`, {
        maxLength: ERROR_MESSAGE_CHARS,
      });
    }
    return redactString(String(error), { maxLength: ERROR_MESSAGE_CHARS });
  } catch {
    return 'unknown error';
  }
}

/**
 * Bounded insertion-ordered map keyed by tool call id. The oldest entry is evicted
 * once `limit` is exceeded, so an OpenCode process that runs for weeks cannot grow
 * the timing table without bound (and a missing entry simply yields durationMs:null).
 */
export class BoundedCallMap {
  constructor(limit = MAX_PENDING_CALLS) {
    this.limit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : MAX_PENDING_CALLS;
    this.map = new Map();
  }

  get size() {
    return this.map.size;
  }

  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.limit) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
    return this;
  }

  get(key) {
    return this.map.get(key);
  }

  /** Read and remove: used exactly once, by the matching execute.after hook. */
  take(key) {
    const value = this.map.get(key);
    if (value !== undefined) this.map.delete(key);
    return value;
  }

  delete(key) {
    return this.map.delete(key);
  }

  clear() {
    this.map.clear();
  }
}

// --- append-only JSONL writer -----------------------------------------------------

function formatDay(date) {
  // UTC day boundaries keep filenames stable across DST and machine timezones.
  return date.toISOString().slice(0, 10);
}

function modeOf(stats) {
  return typeof stats?.mode === 'number' ? stats.mode & 0o777 : null;
}

function octal(mode) {
  return mode === null ? 'unknown' : `0${mode.toString(8).padStart(3, '0')}`;
}

/**
 * Create the append-only writer. Never throws: an unwritable, wrongly-permissioned or
 * unsafe audit directory makes `record()` a no-op (`enabled === false`) so the plugin
 * still loads.
 *
 * Failure is fail-closed on purpose. If the directory cannot be verified as 0700, or the
 * day file cannot be opened as a regular file and verified as 0600, the writer disables
 * itself instead of appending secrets to a world-readable file (or trusting a symlink).
 */
export function createAuditLog(options = {}) {
  const directory = options.directory ? path.resolve(options.directory) : resolveAuditDir();
  const clock = typeof options.clock === 'function' ? options.clock : () => new Date();
  // Test seam: lets the suite simulate a filesystem that refuses to honour mode changes.
  const io = options.fileSystem ?? fs;

  let enabled = true;
  let closed = false;
  let disabledReason = null;
  let fd = null;
  let currentDay = null;
  let currentPath = null;

  function disable(error) {
    enabled = false;
    disabledReason = describeError(error);
    if (fd !== null) {
      try {
        io.closeSync(fd);
      } catch {
        // ignore
      }
      fd = null;
    }
    currentDay = null;
    currentPath = null;
  }

  function prepareDirectory() {
    try {
      io.mkdirSync(directory, { recursive: true, mode: AUDIT_DIR_MODE });
    } catch (error) {
      disable(error);
      return false;
    }
    try {
      const before = io.lstatSync(directory);
      if (before.isSymbolicLink() || !before.isDirectory()) {
        disable(new Error(`audit directory is not a real directory: ${directory}`));
        return false;
      }
      try {
        io.chmodSync(directory, AUDIT_DIR_MODE);
      } catch (error) {
        disable(new Error(`cannot enforce 0700 on audit directory ${directory}: ${describeError(error)}`));
        return false;
      }
      const after = io.statSync(directory);
      if (!after.isDirectory() || modeOf(after) !== AUDIT_DIR_MODE) {
        disable(
          new Error(
            `audit directory mode is ${octal(modeOf(after))}, expected 0700: ${directory}`,
          ),
        );
        return false;
      }
      return true;
    } catch (error) {
      disable(error);
      return false;
    }
  }

  prepareDirectory();

  function closeFd() {
    if (fd === null) return;
    try {
      io.closeSync(fd);
    } catch {
      // ignore
    }
    fd = null;
  }

  function openFor(date) {
    const day = formatDay(date);
    if (fd !== null && currentDay === day) return true;
    closeFd();

    const file = path.join(directory, `${day}.jsonl`);

    try {
      const existing = io.lstatSync(file);
      if (existing.isSymbolicLink() || !existing.isFile()) {
        throw new Error(`refusing to write audit log: ${file} is not a regular file`);
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }

    const constants = io.constants ?? fs.constants;
    const flags =
      constants.O_CREAT |
      constants.O_APPEND |
      constants.O_WRONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0);
    const candidate = io.openSync(file, flags, AUDIT_FILE_MODE);
    let accepted = false;
    try {
      const stats = io.fstatSync(candidate);
      if (!stats.isFile()) {
        throw new Error(`refusing to write audit log: ${file} is not a regular file`);
      }
      try {
        io.fchmodSync(candidate, AUDIT_FILE_MODE);
      } catch (error) {
        throw new Error(`cannot enforce 0600 on audit log ${file}: ${describeError(error)}`);
      }
      const after = io.fstatSync(candidate);
      if (!after.isFile() || modeOf(after) !== AUDIT_FILE_MODE) {
        throw new Error(`audit log mode is ${octal(modeOf(after))}, expected 0600: ${file}`);
      }
      fd = candidate;
      accepted = true;
      currentDay = day;
      currentPath = file;
      return true;
    } finally {
      if (!accepted) {
        try {
          io.closeSync(candidate);
        } catch {
          // ignore
        }
      }
    }
  }

  function writeAll(bytes) {
    let offset = 0;
    while (offset < bytes.length) {
      const written = io.writeSync(fd, bytes, offset, bytes.length - offset);
      if (!Number.isFinite(written) || written <= 0) {
        throw new Error('short write to audit log');
      }
      offset += written;
    }
  }

  function write(event, data) {
    if (!enabled || closed) return false;
    try {
      const now = clock();
      const ts = now.toISOString();
      let line;
      try {
        const record = { ts, v: 1, event, ...data };
        line = JSON.stringify(record);
      } catch (error) {
        line = JSON.stringify({
          ts,
          v: 1,
          event,
          serializationError: describeError(error),
        });
      }
      if (line.length > MAX_LINE_CHARS) {
        line = JSON.stringify({
          ts,
          v: 1,
          event,
          truncated: true,
          originalChars: line.length,
        });
      }
      openFor(now);
      writeAll(Buffer.from(`${line}\n`, 'utf8'));
      return true;
    } catch (error) {
      disable(error);
      return false;
    }
  }

  function close() {
    closed = true;
    closeFd();
    currentDay = null;
  }

  return {
    record: write,
    close,
    get enabled() {
      return enabled;
    },
    get directory() {
      return directory;
    },
    get path() {
      return currentPath;
    },
    get disabledReason() {
      return disabledReason;
    },
  };
}

// --- read-only helpers ------------------------------------------------------------

function optionalRedact(value) {
  return typeof value === 'undefined' ? null : redact(value);
}

function summarizeStructuredError(error, depth = 0) {
  if (error === null || typeof error === 'undefined') return null;
  if (depth > 3) return '[MaxDepth]';
  if (typeof error === 'string') return redactString(error, { maxLength: ERROR_MESSAGE_CHARS });
  if (typeof error !== 'object') return redact(error);
  try {
    if (safeInstanceOf(error, Error)) {
      const rawName = safeRead(error, 'name');
      const summary = {
        name: redactString(typeof rawName === 'string' && rawName.length > 0 ? rawName : 'Error', {
          maxLength: ERROR_MESSAGE_CHARS,
        }),
        message: redactString(String(safeRead(error, 'message') ?? ''), {
          maxLength: ERROR_MESSAGE_CHARS,
        }),
      };
      const code = safeRead(error, 'code');
      if (typeof code !== 'undefined') summary.code = redact(code);
      const metadata = safeRead(error, 'metadata');
      if (typeof metadata !== 'undefined') summary.metadata = redact(metadata);
      const cause = safeRead(error, 'error');
      if (cause && cause !== error) summary.cause = summarizeStructuredError(cause, depth + 1);
      return summary;
    }
    const summary = {};
    const name = safeRead(error, 'name') ?? safeRead(error, '_tag');
    if (typeof name !== 'undefined') {
      summary.name =
        typeof name === 'string'
          ? redactString(name, { maxLength: ERROR_MESSAGE_CHARS })
          : redact(name);
    }
    const message = safeRead(error, 'message');
    if (typeof message !== 'undefined') {
      summary.message = redactString(String(message), { maxLength: ERROR_MESSAGE_CHARS });
    }
    const code = safeRead(error, 'code');
    if (typeof code !== 'undefined') summary.code = redact(code);
    if (Object.keys(summary).length === 0) return redact(error);
    return summary;
  } catch {
    return '[Unreadable error]';
  }
}

export { summarizeStructuredError as summarizeError };

function summarizeContentPart(part) {
  if (typeof part === 'string') {
    return {
      type: 'text',
      chars: part.length,
      preview: redactString(part, { maxLength: RESULT_PREVIEW_CHARS }),
    };
  }
  if (!part || typeof part !== 'object') return redact(part);
  const text = safeRead(part, 'text');
  if (typeof text === 'string') {
    return {
      type: 'text',
      chars: text.length,
      preview: redactString(text, { maxLength: RESULT_PREVIEW_CHARS }),
    };
  }
  if (safeRead(part, 'type') === 'file') {
    return {
      type: 'file',
      uri: redact(safeRead(part, 'uri')),
      mime: redact(safeRead(part, 'mime')),
      name: redact(safeRead(part, 'name')),
    };
  }
  return redact(part);
}

/**
 * Summarize a tool result instead of logging it. A file read can be megabytes; the
 * audit log needs "what came back" (kind, size, a redacted preview), not the payload.
 */
export function summarizeToolResult(result) {
  if (result === null || typeof result === 'undefined') return null;
  if (typeof result !== 'object') return { value: redact(result) };
  try {
    const summary = {};
    if ('output' in result) {
      const output = safeRead(result, 'output');
      if (typeof output === 'string') {
        summary.output = {
          type: 'text',
          chars: output.length,
          preview: redactString(output, { maxLength: RESULT_PREVIEW_CHARS }),
        };
      } else {
        summary.output = redact(output);
      }
    }
    if ('content' in result) {
      const content = safeRead(result, 'content');
      if (typeof content === 'string') {
        summary.content = {
          type: 'text',
          chars: content.length,
          preview: redactString(content, { maxLength: RESULT_PREVIEW_CHARS }),
        };
      } else if (Array.isArray(content)) {
        summary.content = {
          type: 'parts',
          count: content.length,
          parts: content.slice(0, 20).map(summarizeContentPart),
        };
      } else {
        summary.content = redact(content);
      }
    }
    if ('metadata' in result) summary.metadata = redact(safeRead(result, 'metadata'));
    return summary;
  } catch {
    return { unreadable: true };
  }
}

function extractEditedFilePaths(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return [];
  const paths = [];
  for (const key of ['path', 'filePath', 'file']) {
    const val = safeRead(toolInput, key);
    if (typeof val === 'string' && val.trim().length > 0) paths.push(val.trim());
  }
  return paths;
}

/**
 * Extract the final assistant text from `ctx.session.context({ sessionID })` messages.
 * Distinguishes a tool-call-only turn (`hasToolCalls: true, text: ''`) from a genuinely
 * empty final assistant response so `experimental.idle` does not emit spurious "empty" reports.
 */
function inspectLatestAssistantMessage(messages) {
  if (!Array.isArray(messages)) return { found: false, text: '', hasToolCalls: false };
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    const role = safeRead(msg, 'role') ?? safeRead(msg, 'type');
    if (role !== 'assistant') continue;
    const text = safeRead(msg, 'text');
    if (typeof text === 'string' && text.trim().length > 0) {
      return { found: true, text, hasToolCalls: false };
    }
    const content = safeRead(msg, 'content');
    if (typeof content === 'string') {
      return { found: true, text: content, hasToolCalls: false };
    }
    if (Array.isArray(content)) {
      let hasToolCalls = false;
      const parts = [];
      for (const part of content) {
        if (typeof part === 'string') {
          parts.push(part);
          continue;
        }
        const partType = safeRead(part, 'type');
        if (partType === 'tool' || partType === 'tool-call' || partType === 'tool_use') {
          hasToolCalls = true;
          continue;
        }
        if (partType === 'text' || partType === undefined) {
          const t = safeRead(part, 'text');
          if (typeof t === 'string') parts.push(t);
        }
      }
      return { found: true, text: parts.filter(Boolean).join('\n'), hasToolCalls };
    }
    return { found: true, text: '', hasToolCalls: false };
  }
  return { found: false, text: '', hasToolCalls: false };
}

function appendFallbackToToolResult(result, notice) {
  if (!result || typeof result !== 'object' || typeof notice !== 'string' || !notice) return;
  try {
    if (typeof result.output === 'string') {
      result.output = result.output.trim().length > 0 ? `${result.output}\n\n${notice}` : notice;
    } else if (result.output && typeof result.output === 'object' && typeof result.output.output === 'string') {
      result.output.output = result.output.output.trim().length > 0 ? `${result.output.output}\n\n${notice}` : notice;
    }
    if (Array.isArray(result.content)) {
      result.content.push({ type: 'text', text: notice });
    } else if (typeof result.content === 'string') {
      result.content = result.content.trim().length > 0 ? `${result.content}\n\n${notice}` : notice;
    }
  } catch {
    // Non-extensible/frozen result object: diagnostic is still saved in the Blackboard.
  }
}

// --- plugin -----------------------------------------------------------------------

export default Plugin.define({
  id: PLUGIN_ID,

  async setup(ctx) {
    let log;
    try {
      log = createAuditLog();
    } catch (error) {
      log = {
        record: () => false,
        close: () => {},
        enabled: false,
        directory: 'unavailable',
        disabledReason: describeError(error),
      };
    }

    const locationDir = safeRead(ctx?.location, 'directory') ?? null;
    const locationWorkspaceID = safeRead(ctx?.location, 'workspaceID') ?? null;
    const instanceLocation = locationDir
      ? {
          directory: optionalRedact(locationDir),
          workspaceID: optionalRedact(locationWorkspaceID),
        }
      : null;

    const bus = getSharedBus(log.directory);
    const blackboard = createBlackboardManager();
    const calls = new BoundedCallMap(MAX_PENDING_CALLS);
    const processedBgResults = new BoundedSeenSet(2_000);
    /** @type {Array<{ dispose: () => Promise<void> | void }>} */
    const registrations = [];
    let cleaned = false;
    let cleanupPromise = null;

    const record = (event, data = {}) => {
      try {
        log.record(event, data);
      } catch {
        // createAuditLog().record already swallows; this is belt and braces.
      }
    };

    const guardOptions = safeRead(ctx?.options, 'guard');
    const onSessionRotated = ({ newSessionID, rootSessionID, directory, agent, model }) => {
      bus.updateSessionMeta(newSessionID, { rootSessionID, directory, agent, model });
    };

    let guard;
    try {
      guard = guardOptions && typeof guardOptions === 'object'
        ? createReactiveGuard({
            config: guardOptions.config ?? guardOptions,
            judge: guardOptions.judge,
            fetchImpl: guardOptions.fetchImpl,
            clock: guardOptions.clock,
            blackboard,
            record,
            onSessionRotated,
          })
        : bus.getSharedSlot('reactiveGuard', () =>
            createReactiveGuard({
              blackboard,
              record,
              onSessionRotated,
            }),
          );
    } catch (error) {
      // A banned model in config/env (or any other construction failure) must never take the
      // whole plugin — audit logger and Wave 1 permission guard included — down with it.
      record('plugin.error', { where: 'guard.init', message: describeError(error) });
      guard = createReactiveGuard({ config: { enabled: false }, env: {}, blackboard, record });
    }

    const memoryOptions = safeRead(ctx?.options, 'memoryRefresh');
    let memoryRefresher;
    try {
      memoryRefresher = createMemoryRefresher({
        config: memoryOptions && typeof memoryOptions === 'object' ? (memoryOptions.config ?? memoryOptions) : undefined,
        llm: memoryOptions?.llm,
        clock: memoryOptions?.clock,
        dbPath: memoryOptions?.dbPath !== undefined ? memoryOptions.dbPath : false,
        auditDir: log.directory !== 'unavailable' ? log.directory : null,
        record,
      });
    } catch (error) {
      record('plugin.error', { where: 'memoryRefresh.init', message: describeError(error) });
      memoryRefresher = createMemoryRefresher({ config: { enabled: false }, env: {}, record });
    }

    function resolveLocationForSession(sessionID, explicitLocation = null) {
      if (explicitLocation && typeof explicitLocation === 'object' && safeRead(explicitLocation, 'directory')) {
        return optionalRedact(explicitLocation);
      }
      const meta = typeof sessionID === 'string' ? bus.getSessionMeta(sessionID) : null;
      if (meta?.directory) {
        return {
          directory: optionalRedact(meta.directory),
          workspaceID: optionalRedact(meta.workspaceID),
        };
      }
      if (instanceLocation) return instanceLocation;
      return optionalRedact(explicitLocation);
    }

    function resolveModelForSession(sessionID, explicitModel = undefined) {
      const formatted = formatModelRef(explicitModel);
      if (formatted) return optionalRedact(formatted);
      const meta = typeof sessionID === 'string' ? bus.getSessionMeta(sessionID) : null;
      return meta?.model ? optionalRedact(meta.model) : null;
    }

    function touchSession(sessionID, patch = {}) {
      if (typeof sessionID !== 'string' || sessionID.length === 0) return null;
      return bus.updateSessionMeta(sessionID, {
        directory: locationDir,
        workspaceID: locationWorkspaceID,
        ...patch,
      });
    }

    async function resolveRootFor(sessionID) {
      if (typeof sessionID !== 'string' || sessionID.length === 0) return null;
      let meta = bus.getSessionMeta(sessionID);
      if (!meta?.parentSessionID && !meta?.rootSessionID && typeof ctx?.session?.get === 'function') {
        try {
          const info = await ctx.session.get({ sessionID });
          const parentID = safeRead(info, 'parentID') ?? safeRead(info, 'parent_id');
          if (typeof parentID === 'string' && parentID.length > 0) {
            bus.linkChildSession(sessionID, parentID, {
              directory: safeRead(info, 'directory') ?? locationDir,
              agent: safeRead(info, 'agent'),
            });
          }
        } catch {
          // Best-effort lookup only.
        }
      }
      return bus.resolveRootSessionID(sessionID) ?? sessionID;
    }

    record('plugin.loaded', {
      plugin: PLUGIN_ID,
      app: {
        name: optionalRedact(safeRead(ctx?.app, 'name')),
        version: optionalRedact(safeRead(ctx?.app, 'version')),
        channel: optionalRedact(safeRead(ctx?.app, 'channel')),
      },
      location: {
        directory: optionalRedact(locationDir),
        workspaceID: optionalRedact(locationWorkspaceID),
      },
      auditDir: log.directory,
      loggingEnabled: log.enabled,
      loggingDisabledReason: log.disabledReason,
      pid: process.pid,
      node: process.version,
      platform: process.platform,
      optionKeys: (() => {
        try {
          return Object.keys(ctx?.options ?? {});
        } catch {
          return [];
        }
      })(),
    });

    async function addHook(domainName, hookName, callback) {
      try {
        const domain = safeRead(ctx, domainName);
        if (!domain || typeof domain.hook !== 'function') return;
        const registration = await domain.hook(hookName, callback);
        if (registration && typeof registration.dispose === 'function') {
          registrations.push(registration);
        }
      } catch (error) {
        record('plugin.hook.registration_failed', {
          hook: `${domainName}.${hookName}`,
          message: describeError(error),
        });
      }
    }

    // (a) session.prompt — auto-materialize inline attachments + record redacted preview.
    await addHook('session', 'prompt', async (input) => {
      try {
        const sessionID = safeRead(input, 'sessionID');
        const messageID = safeRead(input, 'messageID');
        const prompt = safeRead(input, 'prompt') ?? {};
        const text = safeRead(prompt, 'text');
        const files = safeRead(prompt, 'files');
        const agents = safeRead(prompt, 'agents');
        const skills = safeRead(prompt, 'skills');

        touchSession(sessionID);
        if (typeof sessionID === 'string' && sessionID.length > 0) {
          const meta = bus.getSessionMeta(sessionID);
          try {
            guard.onPrompt({
              sessionID,
              text: typeof text === 'string' ? text : '',
              directory: locationDir,
              parentSessionID: meta?.parentSessionID ?? null,
              rootSessionID: meta?.rootSessionID ?? sessionID,
            });
          } catch (error) {
            record('plugin.error', { where: 'guard.onPrompt', message: describeError(error) });
          }
        }

        let materialized = [];
        if (typeof sessionID === 'string' && Array.isArray(files) && files.length > 0) {
          try {
            const rootSessionID = (await resolveRootFor(sessionID)) ?? sessionID;
            materialized = blackboard.materializeAttachments({
              rootSessionID,
              messageID: typeof messageID === 'string' ? messageID : null,
              files,
              directory: locationDir,
            });
          } catch (error) {
            record('plugin.error', { where: 'blackboard.materialize', message: describeError(error) });
          }
        }

        const payload = {
          sessionID: optionalRedact(sessionID),
          messageID: optionalRedact(messageID),
          delivery: optionalRedact(safeRead(input, 'delivery')),
          location: resolveLocationForSession(sessionID),
          model: resolveModelForSession(sessionID),
          prompt: {
            chars: typeof text === 'string' ? text.length : 0,
            preview:
              typeof text === 'string'
                ? redactString(text, { maxLength: PROMPT_PREVIEW_CHARS })
                : null,
          },
          files: Array.isArray(files)
            ? {
                count: files.length,
                items: files.slice(0, MAX_LISTED_ITEMS).map((file) => ({
                  uri: optionalRedact(safeRead(file, 'uri')),
                  name: optionalRedact(safeRead(file, 'name')),
                  mime: optionalRedact(safeRead(file, 'mime')),
                })),
              }
            : optionalRedact(files),
          agents: Array.isArray(agents)
            ? agents.slice(0, MAX_LISTED_ITEMS).map((agent) => optionalRedact(safeRead(agent, 'name')))
            : optionalRedact(agents),
          skills: Array.isArray(skills)
            ? skills.slice(0, MAX_LISTED_ITEMS).map((skill) => optionalRedact(safeRead(skill, 'id')))
            : optionalRedact(skills),
          metadata: optionalRedact(safeRead(input, 'metadata')),
        };
        if (materialized.length > 0) {
          payload.blackboardAttachments = materialized.map((item) => ({
            name: optionalRedact(item.name),
            mime: optionalRedact(item.mime),
            bytes: item.bytes,
            path: optionalRedact(item.path),
          }));
        }
        record('session.prompt', payload);
      } catch (error) {
        record('plugin.error', { where: 'session.prompt', message: describeError(error) });
      }
    });

    // (b) session.context — capture authoritative model/agent, refresh Blackboard pointer for
    //     child sessions, and validate async `<background-result kind="subagent">` returns.
    await addHook('session', 'context', async (input) => {
      try {
        const sessionID = safeRead(input, 'sessionID');
        const agent = safeRead(input, 'agent');
        const model = safeRead(input, 'model');
        touchSession(sessionID, { agent, model });

        if (typeof sessionID !== 'string' || sessionID.length === 0) return;

        const rootSessionID = (await resolveRootFor(sessionID)) ?? sessionID;
        const meta = bus.getSessionMeta(sessionID);
        const isChildSession = Boolean(meta?.parentSessionID && meta.parentSessionID !== sessionID);

        try {
          guard.onSessionContext({
            sessionID,
            agent: typeof agent === 'string' ? agent : null,
            model: formatModelRef(model),
            directory: locationDir,
            parentSessionID: meta?.parentSessionID ?? null,
            rootSessionID,
          });
        } catch (error) {
          record('plugin.error', { where: 'guard.onSessionContext', message: describeError(error) });
        }

        // Refresh Blackboard pointer in child system prompt so resumed/long-running children
        // see newly materialized attachments and sibling reports.
        if (isChildSession && blackboard.exists(rootSessionID)) {
          try {
            const system = safeRead(input, 'system');
            if (Array.isArray(system)) {
              blackboard.injectIntoSystemParts(system, rootSessionID);
            }
          } catch (error) {
            record('plugin.error', { where: 'blackboard.context_inject', message: describeError(error) });
          }
        }

        // Capture & validate `<background-result kind="subagent">` notices delivered to parent.
        const messages = safeRead(input, 'messages');
        if (Array.isArray(messages) && messages.length > 0) {
          const bgResults = extractBackgroundSubagentResults(messages);
          for (const bg of bgResults) {
            const bgKey = `${bg.sessionID}:${bg.state}:${bg.body.length}:${bg.body.slice(0, 64)}`;
            const isFirstSight = processedBgResults.addIfNew(bgKey);
            try {
              const childMeta = bus.getSessionMeta(bg.sessionID);
              const recorded = isFirstSight
                ? blackboard.recordSubagentReport({
                    rootSessionID,
                    sessionID: bg.sessionID,
                    agent: childMeta?.agent || bg.agent || 'subagent',
                    description: bg.description,
                    text: bg.body,
                    status: bg.state || 'completed',
                    directory: locationDir,
                  })
                : (() => {
                    const existing = blackboard.readManifest(rootSessionID)?.reports?.find(
                      (r) => r.sessionID === bg.sessionID && !r.valid,
                    );
                    if (!existing) return null;
                    return {
                      validation: { valid: false, issue: existing.issue },
                      fallbackNotice: [
                        `[Blackboard validation warning: child ${existing.agent} (${existing.sessionID}) returned ${existing.issue}]`,
                        `Exit/state: ${bg.state || 'completed'}`,
                        existing.gitStatus ? `Workspace git status --short:\n${existing.gitStatus}` : '',
                        existing.path ? `Diagnostic report saved: ${existing.path}` : '',
                      ].filter(Boolean).join('\n'),
                    };
                  })();
              if (isFirstSight) {
                try {
                  await guard.onReviewerOutput({
                    rootSessionID,
                    parentSessionID: sessionID,
                    childSessionID: bg.sessionID,
                    agent: childMeta?.agent || bg.agent || 'subagent',
                    text: bg.body,
                    ctx,
                  });
                } catch (error) {
                  record('plugin.error', { where: 'guard.onReviewerOutput', message: describeError(error) });
                }
              }
              if (recorded && !recorded.validation.valid && recorded.fallbackNotice) {
                const system = safeRead(input, 'system');
                if (Array.isArray(system)) {
                  const diagMarker = `<!-- OCW-SUBAGENT-DIAG:${bg.sessionID} -->`;
                  const existsDiag = system.some(
                    (part) => typeof part?.text === 'string' && part.text.includes(diagMarker),
                  );
                  if (!existsDiag) {
                    system.push({ text: `${diagMarker}\n${recorded.fallbackNotice}` });
                  }
                }
              }
            } catch (error) {
              record('plugin.error', { where: 'blackboard.background_result', message: describeError(error) });
            }
          }
        }
      } catch (error) {
        record('plugin.error', { where: 'session.context', message: describeError(error) });
      }
    });

    // (c) session.experimental.idle — capture completed child subagent output into Blackboard,
    //     and trigger Layer 2 automatic bounded `MEMORY.md` refresh on root sessions.
    await addHook('session', 'experimental.idle', async (input) => {
      try {
        const sessionID = safeRead(input, 'sessionID');
        const background = safeRead(input, 'background');
        const hasPendingBackground = Array.isArray(background) && background.length > 0;
        if (typeof sessionID !== 'string' || sessionID.length === 0) return;

        const rootSessionID = (await resolveRootFor(sessionID)) ?? sessionID;
        const meta = bus.getSessionMeta(sessionID);
        const isChildSession = Boolean(meta?.parentSessionID && meta.parentSessionID !== sessionID);

        if (isChildSession) {
          if (!blackboard.exists(rootSessionID)) return;
          if (typeof ctx?.session?.context === 'function') {
            try {
              const messages = await ctx.session.context({ sessionID });
              const latest = inspectLatestAssistantMessage(messages);
              // Skip tool-call-only turns (not a genuinely empty final response).
              if (!latest.found || (latest.hasToolCalls && latest.text.trim().length === 0)) return;
              blackboard.recordSubagentReport({
                rootSessionID,
                sessionID,
                agent: meta?.agent || 'subagent',
                description: blackboard.readManifest(rootSessionID)?.sessions?.[sessionID]?.description || '',
                text: latest.text,
                status: 'completed',
                directory: meta?.directory || locationDir,
              });
              await guard.onReviewerOutput({
                rootSessionID,
                parentSessionID: meta?.parentSessionID ?? rootSessionID,
                childSessionID: sessionID,
                agent: meta?.agent || 'subagent',
                text: latest.text,
                ctx,
              });
            } catch (error) {
              record('plugin.error', { where: 'blackboard.child_idle', message: describeError(error) });
            }
          }
          return;
        }

        // Layer 2: Root session went idle with no pending background work -> refresh bounded MEMORY.md
        if (hasPendingBackground) return;
        const gState = guard.getSessionState(sessionID);
        const runRefresh = () =>
          memoryRefresher.maybeRefreshOnIdle({
            sessionID,
            isChild: false,
            directory: meta?.directory || locationDir,
            toolCalls: gState?.steps ?? 0,
            fileMutations: gState?.fileMutations ?? 0,
            ctx,
          });
        if (safeRead(ctx?.options, 'syncMemoryRefresh') === true) {
          await runRefresh();
        } else {
          void Promise.resolve().then(runRefresh).catch(() => {});
        }
      } catch (error) {
        record('plugin.error', { where: 'session.experimental.idle', message: describeError(error) });
      }
    });

    // (d) tool.execute.before — inject compact Blackboard pointer into `subagent` spawns + timing.
    await addHook('tool', 'execute.before', async (input) => {
      try {
        const callId = safeRead(input, 'id');
        const toolName = safeRead(input, 'tool');
        const sessionID = safeRead(input, 'sessionID');
        const agent = safeRead(input, 'agent');
        const key = String(callId);

        touchSession(sessionID, { agent });
        calls.set(key, { startedAt: Date.now(), tool: toolName });

        if (toolName === 'subagent' && typeof sessionID === 'string' && sessionID.length > 0) {
          try {
            const rootSessionID = (await resolveRootFor(sessionID)) ?? sessionID;
            blackboard.ensureBoard(rootSessionID, locationDir);
            const toolInput = safeRead(input, 'input');
            if (toolInput && typeof toolInput === 'object' && typeof safeRead(toolInput, 'prompt') === 'string') {
              toolInput.prompt = blackboard.injectIntoPrompt(toolInput.prompt, rootSessionID);
            }
          } catch (error) {
            record('plugin.error', { where: 'blackboard.subagent_before', message: describeError(error) });
          }
        }

        record('tool.before', {
          tool: optionalRedact(toolName),
          callId: optionalRedact(callId),
          sessionID: optionalRedact(sessionID),
          agent: optionalRedact(agent),
          messageID: optionalRedact(safeRead(input, 'messageID')),
          location: resolveLocationForSession(sessionID),
          model: resolveModelForSession(sessionID),
          input: optionalRedact(safeRead(input, 'input')),
        });
      } catch (error) {
        record('plugin.error', { where: 'tool.execute.before', message: describeError(error) });
      }
    });

    // (e) tool.execute.after — track subagent lineage, validate child returns, track file ownership.
    await addHook('tool', 'execute.after', async (input) => {
      try {
        const callId = safeRead(input, 'id');
        const toolName = safeRead(input, 'tool');
        const sessionID = safeRead(input, 'sessionID');
        const agent = safeRead(input, 'agent');
        const status = safeRead(input, 'status');
        const key = String(callId);
        const timing = calls.take(key);

        touchSession(sessionID, { agent });

        if (typeof sessionID === 'string' && sessionID.length > 0) {
          const rootSessionID = (await resolveRootFor(sessionID)) ?? sessionID;

          if (toolName === 'subagent') {
            try {
              const toolInput = safeRead(input, 'input');
              const childAgent = safeRead(toolInput, 'agent') || 'subagent';
              const childDesc = safeRead(toolInput, 'description') || '';

              if (status === 'error') {
                const errSummary = describeError(safeRead(input, 'error'));
                const recorded = blackboard.recordSubagentReport({
                  rootSessionID,
                  sessionID: String(callId || 'subagent_err'),
                  agent: childAgent,
                  description: childDesc,
                  text: '',
                  status: 'error',
                  directory: locationDir,
                  error: errSummary,
                });
                if (recorded?.fallbackNotice) {
                  record('blackboard.subagent_invalid', {
                    rootSessionID: optionalRedact(rootSessionID),
                    sessionID: optionalRedact(sessionID),
                    agent: optionalRedact(childAgent),
                    issue: 'error',
                    reportPath: optionalRedact(recorded.report?.path),
                  });
                }
              } else {
                const resultObj = safeRead(input, 'result');
                const info = extractSubagentResultInfo(resultObj);
                if (info.childSessionID) {
                  bus.linkChildSession(info.childSessionID, sessionID, {
                    directory: locationDir,
                    workspaceID: locationWorkspaceID,
                    agent: childAgent,
                  });
                  guard.onSubagentSpawn({
                    parentSessionID: sessionID,
                    childSessionID: info.childSessionID,
                    agent: childAgent,
                    directory: locationDir,
                  });
                  blackboard.recordSubagentSpawn({
                    rootSessionID,
                    childSessionID: info.childSessionID,
                    agent: childAgent,
                    description: childDesc,
                    directory: locationDir,
                  });
                }
                if (!info.isBackgroundRunning) {
                  const recorded = blackboard.recordSubagentReport({
                    rootSessionID,
                    sessionID: info.childSessionID || String(callId || 'subagent'),
                    agent: childAgent,
                    description: childDesc,
                    text: info.text,
                    status: info.status || String(status || 'completed'),
                    directory: locationDir,
                  });
                  try {
                    await guard.onReviewerOutput({
                      rootSessionID,
                      parentSessionID: sessionID,
                      childSessionID: info.childSessionID || String(callId || 'subagent'),
                      agent: childAgent,
                      text: info.text,
                      ctx,
                    });
                  } catch (error) {
                    record('plugin.error', { where: 'guard.onReviewerOutput', message: describeError(error) });
                  }
                  if (recorded && !recorded.validation.valid && recorded.fallbackNotice) {
                    appendFallbackToToolResult(resultObj, recorded.fallbackNotice);
                    record('blackboard.subagent_invalid', {
                      rootSessionID: optionalRedact(rootSessionID),
                      sessionID: optionalRedact(info.childSessionID || sessionID),
                      agent: optionalRedact(childAgent),
                      issue: recorded.validation.issue,
                      reportPath: optionalRedact(recorded.report?.path),
                    });
                  }
                }
              }
            } catch (error) {
              record('plugin.error', { where: 'blackboard.subagent_after', message: describeError(error) });
            }
          } else if (status === 'completed' && FILE_MUTATION_TOOLS.has(String(toolName || '').toLowerCase())) {
            try {
              const filePaths = extractEditedFilePaths(safeRead(input, 'input'));
              if (filePaths.length > 0) {
                blackboard.recordFileOwnership({
                  rootSessionID,
                  sessionID,
                  agent: agent || 'unknown',
                  filePaths,
                  directory: locationDir,
                });
              }
            } catch (error) {
              record('plugin.error', { where: 'blackboard.file_ownership', message: describeError(error) });
            }
          } else if (status === 'error') {
            try {
              blackboard.recordFailedAttempt({
                rootSessionID,
                sessionID,
                agent: agent || 'unknown',
                tool: toolName || 'tool',
                summary: describeError(safeRead(input, 'error')),
                directory: locationDir,
              });
            } catch (error) {
              record('plugin.error', { where: 'blackboard.failed_attempt', message: describeError(error) });
            }
          }
        }

        const data = {
          tool: optionalRedact(toolName),
          callId: optionalRedact(callId),
          sessionID: optionalRedact(sessionID),
          agent: optionalRedact(agent),
          messageID: optionalRedact(safeRead(input, 'messageID')),
          location: resolveLocationForSession(sessionID),
          model: resolveModelForSession(sessionID),
          status: optionalRedact(status),
          durationMs: timing ? Math.max(0, Date.now() - timing.startedAt) : null,
          timing: timing ? 'measured' : 'unknown',
          input: optionalRedact(safeRead(input, 'input')),
        };
        if (status === 'error') {
          data.error = summarizeStructuredError(safeRead(input, 'error'));
        } else {
          data.result = summarizeToolResult(safeRead(input, 'result'));
        }
        record('tool.after', data);

        // Wave 2 Layer 0/1: feed tool completion into the Always-On Reactive Security Guard.
        if (typeof sessionID === 'string' && sessionID.length > 0) {
          const meta = bus.getSessionMeta(sessionID);
          try {
            await guard.onToolAfter({
              sessionID,
              tool: toolName,
              status,
              input: safeRead(input, 'input'),
              error: status === 'error' ? describeError(safeRead(input, 'error')) : null,
              agent: agent || meta?.agent || null,
              directory: meta?.directory || locationDir,
              parentSessionID: meta?.parentSessionID ?? null,
              rootSessionID: bus.resolveRootSessionID(sessionID) ?? sessionID,
              ctx,
            });
          } catch (error) {
            record('plugin.error', { where: 'guard.onToolAfter', message: describeError(error) });
          }
        }
      } catch (error) {
        record('plugin.error', { where: 'tool.execute.after', message: describeError(error) });
      }
    });

    // (f) permission.evaluate — structured JS shell/secret evaluator + audit record.
    await addHook('permission', 'evaluate', async (input) => {
      try {
        const sessionID = safeRead(input, 'sessionID');
        const agent = safeRead(input, 'agent');
        touchSession(sessionID, { agent });
        const meta = typeof sessionID === 'string' ? bus.getSessionMeta(sessionID) : null;

        let guard = { overridden: false, originalEffect: safeRead(input, 'effect') ?? null, reason: null, category: null };
        try {
          guard = evaluatePermissionInput(input, {
            agent: meta?.agent ?? null,
            isChildSession: Boolean(meta?.rootSessionID && meta.rootSessionID !== sessionID),
          });
        } catch (error) {
          record('plugin.error', { where: 'permission.guard', message: describeError(error) });
        }

        const resources = safeRead(input, 'resources');
        const payload = {
          sessionID: optionalRedact(sessionID),
          agent: optionalRedact(agent),
          location: resolveLocationForSession(sessionID),
          model: resolveModelForSession(sessionID),
          action: optionalRedact(safeRead(input, 'action')),
          resources: Array.isArray(resources)
            ? resources.slice(0, 100).map((resource) => optionalRedact(resource))
            : optionalRedact(resources),
          effect: optionalRedact(safeRead(input, 'effect')),
          originalEffect: optionalRedact(guard.originalEffect),
          source: optionalRedact(safeRead(input, 'source')),
          message: (() => {
            const message = safeRead(input, 'message');
            if (message === null || typeof message === 'undefined') return null;
            return redactString(String(message), { maxLength: ERROR_MESSAGE_CHARS });
          })(),
        };
        if (guard.overridden) {
          payload.guardOverridden = true;
          payload.guardCategory = guard.category ?? null;
          payload.guardReason = guard.reason ? redactString(guard.reason, { maxLength: 300 }) : null;
        }
        record('permission.evaluate', payload);
      } catch (error) {
        record('plugin.error', { where: 'permission.evaluate', message: describeError(error) });
      }
    });

    // (g) shell.create.before — command/cwd/timeout/shell only. NEVER env values.
    await addHook('shell', 'create.before', async (input) => {
      try {
        const command = safeRead(input, 'command');
        const timeout = safeRead(input, 'timeout');
        let envVarCount = null;
        try {
          const env = safeRead(input, 'env');
          if (env && typeof env === 'object') envVarCount = Object.keys(env).length;
        } catch {
          envVarCount = null;
        }
        record('shell.before', {
          command:
            typeof command === 'string'
              ? redactString(command, { maxLength: 2000 })
              : optionalRedact(command),
          cwd: optionalRedact(safeRead(input, 'cwd')),
          timeout: typeof timeout === 'number' && Number.isFinite(timeout) ? timeout : null,
          shell: optionalRedact(safeRead(input, 'shell')),
          envVarCount,
        });
      } catch (error) {
        record('plugin.error', { where: 'shell.create.before', message: describeError(error) });
      }
    });

    // (h) Shared background event subscriber (1 active stream per auditDir group + eventID dedupe).
    function logEvent(event) {
      const type = safeRead(event, 'type');
      const eventType = typeof type === 'string' ? type : 'unknown';
      const data = safeRead(event, 'data') ?? {};
      const sessionID = safeRead(data, 'sessionID');
      const eventLocation = safeRead(event, 'location');

      if (typeof sessionID === 'string' && sessionID.length > 0 && eventLocation && safeRead(eventLocation, 'directory')) {
        bus.updateSessionMeta(sessionID, {
          directory: safeRead(eventLocation, 'directory'),
          workspaceID: safeRead(eventLocation, 'workspaceID'),
        });
      }

      const resolvedLocation = (() => {
        if (eventLocation && typeof eventLocation === 'object' && safeRead(eventLocation, 'directory')) {
          return optionalRedact(eventLocation);
        }
        const meta = typeof sessionID === 'string' ? bus.getSessionMeta(sessionID) : null;
        if (meta?.directory) {
          return {
            directory: optionalRedact(meta.directory),
            workspaceID: optionalRedact(meta.workspaceID),
          };
        }
        return optionalRedact(eventLocation);
      })();

      const payload = {
        eventID: optionalRedact(safeRead(event, 'id')),
        sessionID: optionalRedact(sessionID),
        location: resolvedLocation,
      };
      const knownModel = resolveModelForSession(sessionID);
      if (knownModel) payload.model = knownModel;

      switch (eventType) {
        case 'session.usage.updated':
          payload.cost = optionalRedact(safeRead(data, 'cost'));
          payload.tokens = optionalRedact(safeRead(data, 'tokens'));
          break;
        case 'session.execution.failed':
          payload.error = summarizeStructuredError(safeRead(data, 'error'));
          break;
        case 'session.execution.interrupted':
          payload.reason = optionalRedact(safeRead(data, 'reason'));
          break;
        case 'session.idle':
          payload.background = optionalRedact(safeRead(data, 'background'));
          break;
        case 'session.compaction.started':
          payload.reason = optionalRedact(safeRead(data, 'reason'));
          payload.inputID = optionalRedact(safeRead(data, 'inputID'));
          break;
        case 'session.compaction.ended': {
          const compactionModel = safeRead(data, 'model');
          if (typeof sessionID === 'string' && compactionModel) {
            bus.updateSessionMeta(sessionID, { model: compactionModel });
          }
          payload.reason = optionalRedact(safeRead(data, 'reason'));
          payload.model = optionalRedact(compactionModel);
          payload.cost = optionalRedact(safeRead(data, 'cost'));
          payload.tokens = optionalRedact(safeRead(data, 'tokens'));
          const text = safeRead(data, 'text');
          if (typeof text === 'string') {
            payload.text = {
              chars: text.length,
              preview: redactString(text, { maxLength: COMPACTION_PREVIEW_CHARS }),
            };
          }
          break;
        }
        case 'session.compaction.failed':
          payload.reason = optionalRedact(safeRead(data, 'reason'));
          payload.error = summarizeStructuredError(safeRead(data, 'error'));
          payload.cost = optionalRedact(safeRead(data, 'cost'));
          payload.tokens = optionalRedact(safeRead(data, 'tokens'));
          payload.inputID = optionalRedact(safeRead(data, 'inputID'));
          break;
        case 'session.compaction.delta': {
          const delta = safeRead(data, 'text') ?? safeRead(data, 'delta');
          payload.chars = typeof delta === 'string' ? delta.length : null;
          break;
        }
        case 'permission.asked': {
          const resources = safeRead(data, 'resources');
          payload.permissionID = optionalRedact(safeRead(data, 'id'));
          payload.action = optionalRedact(safeRead(data, 'action'));
          payload.resources = Array.isArray(resources)
            ? resources.slice(0, 100).map((resource) => optionalRedact(resource))
            : optionalRedact(resources);
          payload.source = optionalRedact(safeRead(data, 'source'));
          payload.message = (() => {
            const message = safeRead(data, 'message');
            if (message === null || typeof message === 'undefined') return null;
            return redactString(String(message), { maxLength: ERROR_MESSAGE_CHARS });
          })();
          payload.metadata = optionalRedact(safeRead(data, 'metadata'));
          break;
        }
        case 'permission.replied':
          payload.requestID = optionalRedact(safeRead(data, 'requestID'));
          payload.reply = optionalRedact(safeRead(data, 'reply'));
          break;
        default:
          payload.data = optionalRedact(data);
          break;
      }

      record(eventType, payload);
    }

    const busHandle = bus.registerInstance({
      eventDomain: safeRead(ctx, 'event'),
      eventTypes: EVENT_TYPES,
      directory: locationDir,
      onAuditEvent: logEvent,
      onBusEvent: (event) => {
        const type = safeRead(event, 'type');
        const data = safeRead(event, 'data') ?? {};
        const sessionID = safeRead(data, 'sessionID');
        if (typeof sessionID !== 'string' || sessionID.length === 0) return;
        const meta = bus.getSessionMeta(sessionID);
        if (type === 'session.usage.updated') {
          void Promise.resolve()
            .then(() =>
              guard.onUsageUpdated({
                sessionID,
                cost: safeRead(data, 'cost'),
                tokens: safeRead(data, 'tokens'),
                directory: meta?.directory || safeRead(safeRead(event, 'location'), 'directory') || locationDir,
                parentSessionID: meta?.parentSessionID ?? null,
                rootSessionID: bus.resolveRootSessionID(sessionID) ?? sessionID,
                ctx,
              }),
            )
            .catch((error) => record('plugin.error', { where: 'guard.onUsageUpdated', message: describeError(error) }));
        } else if (type === 'session.compaction.ended') {
          try {
            guard.onCompactionEnded({ sessionID });
          } catch (error) {
            record('plugin.error', { where: 'guard.onCompactionEnded', message: describeError(error) });
          }
        }
      },
      onError: (where, error) => record('plugin.error', { where, message: describeError(error) }),
    });

    return async function cleanup() {
      if (cleaned) return cleanupPromise;
      cleaned = true;
      cleanupPromise = (async () => {
        let subState = { aborted: false, ended: false, failedOver: false };
        try {
          subState = await busHandle.unregister();
        } catch {
          // ignore
        }

        const pending = registrations.splice(0, registrations.length);
        for (const registration of pending) {
          let timer = null;
          try {
            const outcome = await Promise.race([
              Promise.resolve().then(() => registration.dispose()),
              new Promise((resolve) => {
                timer = setTimeout(() => resolve(DISPOSE_TIMEOUT), DISPOSE_TIMEOUT_MS);
              }),
            ]);
            if (outcome === DISPOSE_TIMEOUT) {
              record('plugin.error', {
                where: 'cleanup.dispose.timeout',
                message: `dispose() exceeded ${DISPOSE_TIMEOUT_MS}ms`,
              });
            }
          } catch (error) {
            record('plugin.error', {
              where: 'cleanup.dispose',
              message: describeError(error),
            });
          } finally {
            if (timer) clearTimeout(timer);
          }
        }
        record('plugin.stopped', {
          plugin: PLUGIN_ID,
          hooksDisposed: pending.length,
          pendingCallTimings: calls.size,
          eventSubscriberAborted: subState.aborted,
          eventSubscriberEnded: subState.ended,
          eventSubscriberFailedOver: subState.failedOver,
        });
        calls.clear();
        try {
          log.close();
        } catch {
          // Teardown must not throw.
        }
      })().catch(() => {
        // cleanup() is a best-effort teardown and always resolves.
      });
      return cleanupPromise;
    };
  },
});
