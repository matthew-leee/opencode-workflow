/**
 * opencode-workflow audit logger — OpenCode v2.3.2 (`@opencode/plugin@2.3.2`).
 *
 * Writes one append-only JSONL record per interesting OpenCode action to
 * `$OPENCODE_WORKFLOW_AUDIT_DIR` (default `~/.local/share/opencode-workflow/audit`),
 * one file per UTC day. Records are redacted with ./redact.js before serialization.
 *
 * Design constraints, in order of priority:
 *
 *   1. The plugin must never break OpenCode. Every hook, event handler and write is
 *      wrapped: failures disable logging, they do not propagate.
 *   2. No secret reaches disk. Tool inputs, shell commands, permission resources and
 *      event payloads pass through deep redaction; `shell.create.before` never touches
 *      the `env` values at all.
 *   3. Log volume is bounded. Strings are capped, the tool-timing map is bounded, and a
 *      single pathological record is replaced by a truncation marker.
 *
 * Host resolution: `Host.resolve` loads a local directory that has a `package.json`
 * without an `exports` map through its conventional entrypoint, so this file is the
 * plugin entrypoint (`main: index.js`). An `exports` map here would make OpenCode try
 * to resolve the directory as an installed package by name instead.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Plugin } from '@opencode/plugin';

import { REDACTED, redact, redactString } from './redact.js';

export { REDACTED, redact, redactString };

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

/**
 * Event types consumed by the background subscriber. Kept as an explicit list so the
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
 *
 * Each record is serialized to one buffer and written with synchronous `writeSync` on an
 * O_APPEND descriptor. `writeAll` loops until every byte is written. On a local regular
 * file a single write appends the whole line atomically, so two OpenCode processes
 * normally do not interleave lines; there is no cross-process lock, so a short write
 * completed by a second append could in principle interleave with another writer. Sync is
 * deliberate: a hook may run right before process exit, and a buffered write would be lost.
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
      // A symlinked audit directory could point at a shared location, so refuse it before
      // any chmod would silently operate on the link target.
      const before = io.lstatSync(directory);
      if (before.isSymbolicLink() || !before.isDirectory()) {
        disable(new Error(`audit directory is not a real directory: ${directory}`));
        return false;
      }
      // Tighten a pre-existing directory too: 0700 is the audit contract, and a
      // world-readable parent would expose yesterday's records.
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

  // `prepareDirectory()` disables the writer itself if the directory is unsafe or the mode
  // cannot be enforced; the writer then stays inert and openFor() is never reached.
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

    // Refuse symlinks and non-regular files before opening. This is a friendly early
    // refusal; the O_NOFOLLOW / O_NONBLOCK open plus fstat check below close the race.
    try {
      const existing = io.lstatSync(file);
      if (existing.isSymbolicLink() || !existing.isFile()) {
        throw new Error(`refusing to write audit log: ${file} is not a regular file`);
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }

    // O_NOFOLLOW refuses a symlink swapped in after the lstat; O_NONBLOCK makes opening a
    // FIFO fail (ENXIO) instead of hanging until a reader appears. Neither changes regular
    // file writes.
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
      // fchmod on the open descriptor, then verify it took effect. If it did not, fail
      // closed rather than append secrets into a world-readable file.
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
        // A payload that cannot be serialized (BigInt left unredacted, toJSON that
        // throws) costs one detail field, not the whole audit trail.
        line = JSON.stringify({
          ts,
          v: 1,
          event,
          serializationError: describeError(error),
        });
      }
      if (line.length > MAX_LINE_CHARS) {
        // A single pathological record must not bloat the log; keep the marker only.
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
        // Error.name is attacker-controlled too (SDKs and providers embed keys in it).
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
    // Structured (schema) errors are plain objects: keep the useful fields only.
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

// --- plugin -----------------------------------------------------------------------

export default Plugin.define({
  id: PLUGIN_ID,

  async setup(ctx) {
    let log;
    try {
      log = createAuditLog();
    } catch (error) {
      // createAuditLog already swallows filesystem failures; this guards the invariant
      // that nothing here can reject the plugin's setup.
      log = {
        record: () => false,
        close: () => {},
        enabled: false,
        directory: 'unavailable',
        disabledReason: describeError(error),
      };
    }
    const calls = new BoundedCallMap(MAX_PENDING_CALLS);
    /** @type {Array<{ dispose: () => Promise<void> | void }>} */
    const registrations = [];
    const controller = new AbortController();
    let cleaned = false;
    let cleanupPromise = null;

    // Best-effort record helper: logging must never escape a hook.
    const record = (event, data = {}) => {
      try {
        log.record(event, data);
      } catch {
        // createAuditLog().record already swallows; this is belt and braces.
      }
    };

    record('plugin.loaded', {
      plugin: PLUGIN_ID,
      app: {
        name: optionalRedact(safeRead(ctx?.app, 'name')),
        version: optionalRedact(safeRead(ctx?.app, 'version')),
        channel: optionalRedact(safeRead(ctx?.app, 'channel')),
      },
      location: {
        directory: optionalRedact(safeRead(ctx?.location, 'directory')),
        workspaceID: optionalRedact(safeRead(ctx?.location, 'workspaceID')),
      },
      auditDir: log.directory,
      loggingEnabled: log.enabled,
      loggingDisabledReason: log.disabledReason,
      pid: process.pid,
      node: process.version,
      platform: process.platform,
      // Option values may be credentials; only names are safe to record.
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

    // (b) session.prompt — a redacted preview, not the prompt body.
    await addHook('session', 'prompt', async (input) => {
      try {
        const prompt = safeRead(input, 'prompt') ?? {};
        const text = safeRead(prompt, 'text');
        const files = safeRead(prompt, 'files');
        const agents = safeRead(prompt, 'agents');
        const skills = safeRead(prompt, 'skills');
        record('session.prompt', {
          sessionID: optionalRedact(safeRead(input, 'sessionID')),
          messageID: optionalRedact(safeRead(input, 'messageID')),
          delivery: optionalRedact(safeRead(input, 'delivery')),
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
        });
      } catch (error) {
        record('plugin.error', { where: 'session.prompt', message: describeError(error) });
      }
    });

    // (c) tool.execute.before / .after, with start times bounded by BoundedCallMap.
    await addHook('tool', 'execute.before', async (input) => {
      try {
        const callId = safeRead(input, 'id');
        const key = String(callId);
        calls.set(key, { startedAt: Date.now(), tool: safeRead(input, 'tool') });
        record('tool.before', {
          tool: optionalRedact(safeRead(input, 'tool')),
          callId: optionalRedact(callId),
          sessionID: optionalRedact(safeRead(input, 'sessionID')),
          agent: optionalRedact(safeRead(input, 'agent')),
          messageID: optionalRedact(safeRead(input, 'messageID')),
          input: optionalRedact(safeRead(input, 'input')),
        });
      } catch (error) {
        record('plugin.error', { where: 'tool.execute.before', message: describeError(error) });
      }
    });

    await addHook('tool', 'execute.after', async (input) => {
      try {
        const callId = safeRead(input, 'id');
        const key = String(callId);
        const timing = calls.take(key);
        const status = safeRead(input, 'status');
        const data = {
          tool: optionalRedact(safeRead(input, 'tool')),
          callId: optionalRedact(callId),
          sessionID: optionalRedact(safeRead(input, 'sessionID')),
          agent: optionalRedact(safeRead(input, 'agent')),
          messageID: optionalRedact(safeRead(input, 'messageID')),
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
      } catch (error) {
        record('plugin.error', { where: 'tool.execute.after', message: describeError(error) });
      }
    });

    // (d) permission.evaluate — the evaluated decision and its resources.
    await addHook('permission', 'evaluate', async (input) => {
      try {
        const resources = safeRead(input, 'resources');
        record('permission.evaluate', {
          sessionID: optionalRedact(safeRead(input, 'sessionID')),
          agent: optionalRedact(safeRead(input, 'agent')),
          action: optionalRedact(safeRead(input, 'action')),
          resources: Array.isArray(resources)
            ? resources.slice(0, 100).map((resource) => optionalRedact(resource))
            : optionalRedact(resources),
          effect: optionalRedact(safeRead(input, 'effect')),
          source: optionalRedact(safeRead(input, 'source')),
          message: (() => {
            const message = safeRead(input, 'message');
            if (message === null || typeof message === 'undefined') return null;
            return redactString(String(message), { maxLength: ERROR_MESSAGE_CHARS });
          })(),
        });
      } catch (error) {
        record('plugin.error', { where: 'permission.evaluate', message: describeError(error) });
      }
    });

    // (e) shell.create.before — command/cwd/timeout/shell only. NEVER env values.
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
          // Count only: env values are never read, logged or serialized.
          envVarCount,
        });
      } catch (error) {
        record('plugin.error', { where: 'shell.create.before', message: describeError(error) });
      }
    });

    // (f) background event subscriber, bounded and abortable.
    function logEvent(event) {
      const type = safeRead(event, 'type');
      const eventType = typeof type === 'string' ? type : 'unknown';
      const data = safeRead(event, 'data') ?? {};
      const payload = {
        eventID: optionalRedact(safeRead(event, 'id')),
        sessionID: optionalRedact(safeRead(data, 'sessionID')),
        location: optionalRedact(safeRead(event, 'location')),
      };

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
          payload.reason = optionalRedact(safeRead(data, 'reason'));
          payload.model = optionalRedact(safeRead(data, 'model'));
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
          // Unknown event shapes are still recorded, defensively redacted.
          payload.data = optionalRedact(data);
          break;
      }

      record(eventType, payload);
    }

    let eventsEnded = false;
    const consumeEvents = (async () => {
      try {
        const eventDomain = safeRead(ctx, 'event');
        if (!eventDomain || typeof eventDomain.subscribe !== 'function') return;
        const stream = eventDomain.subscribe({
          types: EVENT_TYPES,
          signal: controller.signal,
        });
        for await (const event of stream) {
          if (controller.signal.aborted) break;
          try {
            logEvent(event);
          } catch (error) {
            record('plugin.error', { where: 'event.handler', message: describeError(error) });
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          record('plugin.error', { where: 'event.subscriber', message: describeError(error) });
        }
      } finally {
        eventsEnded = true;
      }
    })().catch(() => {
      // The subscriber must never reject into OpenCode's runtime.
      eventsEnded = true;
    });

    return async function cleanup() {
      if (cleaned) return cleanupPromise;
      cleaned = true;
      cleanupPromise = (async () => {
        try {
          controller.abort();
        } catch {
          // ignore
        }
        // Give the subscriber a moment to finish; never let teardown hang OpenCode.
        try {
          let timer;
          await Promise.race([
            consumeEvents,
            new Promise((resolve) => {
              timer = setTimeout(resolve, 1000);
              if (typeof timer.unref === 'function') timer.unref();
            }),
          ]);
          if (timer) clearTimeout(timer);
        } catch {
          // ignore
        }
        const pending = registrations.splice(0, registrations.length);
        for (const registration of pending) {
          // A hook's dispose() is host code: bound it so a hung implementation cannot make
          // teardown (and therefore OpenCode exit) wait forever.
          let timer = null;
          try {
            const outcome = await Promise.race([
              Promise.resolve().then(() => registration.dispose()),
              new Promise((resolve) => {
                // Deliberately ref'd: while a dispose() hangs, this timer is the only thing
                // keeping the process alive long enough to enforce the bound. It is cleared
                // as soon as the race settles, so a fast dispose leaves no handle behind.
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
          eventSubscriberAborted: controller.signal.aborted,
          eventSubscriberEnded: eventsEnded,
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
