/**
 * Per-root-session Shared Blackboard for Main <-> Subagent coordination.
 *
 * Solves three live subagent failure modes observed in production `opencode.db`:
 *   1. Lost inline user photos/PDFs when spawning `fact-checker`/`reviewer`/`worker`
 *      -> auto-materializes attachments on `session.prompt` to stable `0600` paths.
 *   2. Multi-round copy-paste telephone game across sibling subagents
 *      -> stores versioned reports, active file ownership, and failed attempts in
 *      `/tmp/opencode/blackboard/<rootSessionID>/manifest.json` (`0700` dir, `0600` files)
 *      and auto-injects a compact (~150-250 token) pointer block on every `subagent` spawn.
 *   3. Blind empty or malformed child returns (e.g. DeepSeek DSML markup leaks)
 *      -> validates child outputs on `tool.execute.after` AND async completion
 *      (`experimental.idle` / `<background-result>`), attaching real `git status --short`
 *      and exit state whenever output is empty or malformed.
 */

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { redactString } from './redact.js';

export const BLACKBOARD_DIR_ENV = 'OPENCODE_WORKFLOW_BLACKBOARD_DIR';
export const DEFAULT_BLACKBOARD_ROOT = '/tmp/opencode/blackboard';
export const BLACKBOARD_DIR_MODE = 0o700;
export const BLACKBOARD_FILE_MODE = 0o600;
export const BLACKBOARD_MARKER = '<!-- OCW-BLACKBOARD -->';

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENTS = 50;
export const MAX_REPORTS = 50;
export const MAX_FILE_OWNERSHIP = 200;
export const MAX_FAILED_ATTEMPTS = 30;
export const MAX_POINTER_CHARS = 1_200;
export const MAX_REPORT_CHARS = 64_000;
export const GIT_STATUS_TIMEOUT_MS = 3_000;

const MIME_TO_EXT = new Map([
  ['image/jpeg', '.jpg'],
  ['image/jpg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
  ['image/bmp', '.bmp'],
  ['image/svg+xml', '.svg'],
  ['application/pdf', '.pdf'],
  ['text/plain', '.txt'],
  ['text/markdown', '.md'],
  ['application/json', '.json'],
  ['text/csv', '.csv'],
]);

const EXT_TO_MIME = new Map([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.pdf', 'application/pdf'],
  ['.txt', 'text/plain'],
  ['.md', 'text/markdown'],
  ['.json', 'application/json'],
  ['.csv', 'text/csv'],
]);

/** Patterns indicating leaked raw model tool-call markup (e.g. DeepSeek DSML). */
const DSML_PATTERN = /<[｜|]\s*DSML\s*[｜|]/i;
const RAW_TOOL_XML_PATTERN = /<(?:\/)?(?:function_calls|invoke|tool_call|antml:invoke|antml:function_calls)\b/i;

export function resolveBlackboardRoot(env = process.env) {
  const configured = env?.[BLACKBOARD_DIR_ENV];
  if (typeof configured === 'string' && configured.trim().length > 0) {
    return path.resolve(configured.trim());
  }
  return DEFAULT_BLACKBOARD_ROOT;
}

/** Strict sanitizer for session IDs used as directory names (prevents path traversal). */
export function sanitizeSessionID(sessionID) {
  if (typeof sessionID !== 'string') return null;
  const trimmed = sessionID.trim();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(trimmed)) return null;
  return trimmed;
}

/** Sanitize a filename component for safe storage under attachments/ or reports/. */
export function sanitizeFilename(name, fallbackExt = '.bin') {
  const base = path.basename(String(name ?? '').trim());
  const cleaned = base
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^\.+/, '')
    .replace(/_{2,}/g, '_')
    .slice(0, 80);
  if (!cleaned) return `file${fallbackExt}`;
  if (!path.extname(cleaned) && fallbackExt) return `${cleaned}${fallbackExt}`;
  return cleaned;
}

function ensurePrivateDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true, mode: BLACKBOARD_DIR_MODE });
  const stat = fs.lstatSync(dirPath);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`blackboard path is not a real directory: ${dirPath}`);
  }
  const myUid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (myUid !== null && stat.uid !== myUid) {
    throw new Error(`blackboard directory owner mismatch (${stat.uid} !== ${myUid}): ${dirPath}`);
  }
  fs.chmodSync(dirPath, BLACKBOARD_DIR_MODE);
  const after = fs.statSync(dirPath);
  if (!after.isDirectory() || (after.mode & 0o777) !== BLACKBOARD_DIR_MODE) {
    throw new Error(`failed to enforce 0700 mode on blackboard directory: ${dirPath}`);
  }
}

/** Remove newlines and control characters so pointer fields cannot inject markdown lines. */
function singleLine(value, maxLength = 160) {
  return redactString(String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim(), {
    maxLength,
  });
}

const SENSITIVE_ATTACHMENT_BASENAMES = new Set([
  '.env',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'id_xmss',
  'credentials',
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.pgpass',
  '.my.cnf',
  'auth.json',
  'service.json',
]);

const SAFE_ATTACHMENT_ENV_SUFFIXES = new Set([
  'example',
  'sample',
  'template',
  'dist',
  'defaults',
  'default',
  'schema',
  'types',
]);

/** True when an attachment filename/path names a secret file that must never be materialized. */
export function isSensitiveAttachmentName(nameOrPath) {
  if (typeof nameOrPath !== 'string' || nameOrPath.trim().length === 0) return false;
  const normalized = nameOrPath.trim().replace(/\\/g, '/').toLowerCase();
  const base = normalized.includes('/') ? normalized.slice(normalized.lastIndexOf('/') + 1) : normalized;
  if (!base) return false;

  if (SENSITIVE_ATTACHMENT_BASENAMES.has(base)) return true;
  if (/^id_(?:rsa|ed25519|ecdsa|dsa)(?:\.|$)/.test(base) && !base.endsWith('.pub')) return true;
  if (base.endsWith('.pem') || base.endsWith('.p12') || base.endsWith('.pfx') || base.endsWith('.jks')) return true;
  if (/(?:^|\/)secrets\//.test(normalized)) return true;

  if (base === '.env') return true;
  if (base.startsWith('.env.')) {
    const suffix = base.slice('.env.'.length);
    return !SAFE_ATTACHMENT_ENV_SUFFIXES.has(suffix);
  }
  const envMatch = base.match(/^.+\.env(?:\.(.+))?$/);
  if (envMatch) {
    const suffix = envMatch[1] ?? '';
    return !(suffix && SAFE_ATTACHMENT_ENV_SUFFIXES.has(suffix));
  }
  return false;
}

/** Symlink-proof atomic write with 0600 permissions. */
function atomicWritePrivate(filePath, content) {
  const dir = path.dirname(filePath);
  ensurePrivateDir(dir);
  try {
    const existing = fs.lstatSync(filePath);
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new Error(`refusing to overwrite non-regular file: ${filePath}`);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const tmp = path.join(dir, `.${path.basename(filePath)}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  const flags =
    fs.constants.O_CREAT |
    fs.constants.O_EXCL |
    fs.constants.O_WRONLY |
    (fs.constants.O_NOFOLLOW ?? 0);
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
  let fd = null;
  try {
    fd = fs.openSync(tmp, flags, BLACKBOARD_FILE_MODE);
    let offset = 0;
    while (offset < bytes.length) {
      const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
      if (!Number.isFinite(written) || written <= 0) throw new Error('short write');
      offset += written;
    }
    fs.fchmodSync(fd, BLACKBOARD_FILE_MODE);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, filePath);
  } catch (error) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw error;
  }
}

/** Validate child subagent output for empty content or malformed tool-call markup (e.g. DSML). */
export function validateSubagentOutput(text) {
  const value = typeof text === 'string' ? text : '';
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return {
      valid: false,
      issue: 'empty',
      detail: 'subagent returned empty output',
    };
  }
  if (DSML_PATTERN.test(trimmed)) {
    return {
      valid: false,
      issue: 'malformed_dsml',
      detail: 'subagent output contains raw DeepSeek DSML tool markup',
    };
  }
  if (RAW_TOOL_XML_PATTERN.test(trimmed)) {
    return {
      valid: false,
      issue: 'malformed_tool_markup',
      detail: 'subagent output contains raw unexecuted tool-call XML markup',
    };
  }
  return { valid: true, issue: null, detail: null };
}

/** Run bounded `git status --short` in `directory` as objective fallback evidence. */
export function collectWorkspaceFallbackState(directory) {
  if (typeof directory !== 'string' || directory.trim().length === 0 || !fs.existsSync(directory)) {
    return { ok: false, gitStatus: '', error: 'workspace directory unavailable' };
  }
  try {
    const res = spawnSync('git', ['status', '--short'], {
      cwd: directory,
      encoding: 'utf8',
      timeout: GIT_STATUS_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
    });
    if (res.error) {
      return { ok: false, gitStatus: '', error: redactString(res.error.message, { maxLength: 200 }) };
    }
    if (res.status !== 0) {
      return {
        ok: false,
        gitStatus: '',
        error: redactString((res.stderr || `git exited ${res.status}`).trim(), { maxLength: 200 }),
      };
    }
    const statusText = redactString((res.stdout || '').trim(), { maxLength: 1_000 });
    return { ok: true, gitStatus: statusText || '(clean working tree)', error: null };
  } catch (error) {
    return { ok: false, gitStatus: '', error: redactString(String(error?.message ?? error), { maxLength: 200 }) };
  }
}

/** Extract child `sessionID` and background/sync state from a `subagent` tool result. */
export function extractSubagentResultInfo(result) {
  let childSessionID = null;
  let status = null;
  let text = '';

  if (result && typeof result === 'object') {
    if (typeof result.metadata?.sessionID === 'string') childSessionID = result.metadata.sessionID;
    if (typeof result.metadata?.status === 'string') status = result.metadata.status;
    if (result.output && typeof result.output === 'object') {
      if (!childSessionID && typeof result.output.sessionID === 'string') childSessionID = result.output.sessionID;
      if (!status && typeof result.output.status === 'string') status = result.output.status;
      if (typeof result.output.output === 'string') text = result.output.output;
    } else if (typeof result.output === 'string') {
      text = result.output;
    }
    if (!text && Array.isArray(result.content)) {
      text = result.content
        .map((part) => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : ''))
        .filter(Boolean)
        .join('\n');
    } else if (!text && typeof result.content === 'string') {
      text = result.content;
    }
  } else if (typeof result === 'string') {
    text = result;
  }

  if (!childSessionID && text) {
    const match = text.match(/sessionID:\s*(ses_[A-Za-z0-9_-]+)/);
    if (match) childSessionID = match[1];
  }
  const isBackgroundRunning =
    status === 'running' ||
    /subagent is working in the background/i.test(text);

  return { childSessionID, status, text, isBackgroundRunning };
}

/**
 * Parse `<background-result kind="subagent" sessionID="..." state="..." description="...">BODY</background-result>`
 * blocks from parent session messages.
 */
export function extractBackgroundSubagentResults(messages) {
  if (!Array.isArray(messages)) return [];
  const results = [];
  const tagRegex =
    /<background-result\b([^>]*\bkind="subagent"[^>]*)>([\s\S]*?)<\/background-result>/gi;

  for (const msg of messages) {
    const texts = [];
    if (typeof msg?.text === 'string') texts.push(msg.text);
    if (typeof msg?.content === 'string') texts.push(msg.content);
    if (Array.isArray(msg?.content)) {
      for (const part of msg.content) {
        if (typeof part === 'string') texts.push(part);
        else if (typeof part?.text === 'string') texts.push(part.text);
      }
    }
    const meta = msg?.metadata && typeof msg.metadata === 'object' ? msg.metadata : null;
    for (const chunk of texts) {
      let match;
      tagRegex.lastIndex = 0;
      while ((match = tagRegex.exec(chunk)) !== null) {
        const attrs = match[1];
        const body = match[2];
        const attr = (name) => {
          const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`, 'i'));
          return m ? m[1] : null;
        };
        const sessionID = attr('sessionID') || meta?.childID || null;
        const state = attr('state') || meta?.state || 'completed';
        const description = attr('description') || '';
        const agent = meta?.agent || 'subagent';
        if (sessionID) {
          results.push({ sessionID, state, description, agent, body });
        }
      }
    }
  }
  return results;
}

/** Decode a single `PromptInput.FileAttachment` (data URI, inline base64, or `file://` URI). */
function decodeAttachmentPayload(file) {
  if (!file || typeof file !== 'object') return null;
  const uri = typeof file.uri === 'string' ? file.uri : '';
  const name = typeof file.name === 'string' ? file.name : '';
  let mime = typeof file.mime === 'string' && file.mime.trim() ? file.mime.trim().toLowerCase() : null;

  // B2 fix: Refuse secret filenames across ALL attachment paths (data:, inline data, file://)
  // BEFORE decoding or writing anything to /tmp/opencode/blackboard.
  if (isSensitiveAttachmentName(name)) {
    return { skipped: true, reason: `refused to materialize sensitive attachment ${name}` };
  }

  // 1. `data:<mime>;base64,<payload>`
  const dataUrlMatch = uri.match(/^data:([^;,]+)?;base64,([\s\S]+)$/i);
  if (dataUrlMatch) {
    mime = (dataUrlMatch[1] || mime || 'application/octet-stream').trim().toLowerCase();
    const b64 = dataUrlMatch[2].replace(/\s+/g, '');
    const estimatedBytes = Math.floor((b64.length * 3) / 4);
    if (estimatedBytes > MAX_ATTACHMENT_BYTES) {
      return { skipped: true, reason: `attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes` };
    }
    const buffer = Buffer.from(b64, 'base64');
    if (buffer.length === 0 || buffer.length > MAX_ATTACHMENT_BYTES) {
      return { skipped: true, reason: 'empty or oversized base64 payload' };
    }
    return { buffer, mime, name };
  }

  // 2. Direct inline base64 `file.data`
  if (typeof file.data === 'string' && file.data.length > 0) {
    const b64 = file.data.replace(/\s+/g, '');
    const estimatedBytes = Math.floor((b64.length * 3) / 4);
    if (estimatedBytes > MAX_ATTACHMENT_BYTES) {
      return { skipped: true, reason: `attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes` };
    }
    const buffer = Buffer.from(b64, 'base64');
    const ext = path.extname(name).toLowerCase();
    mime = mime || EXT_TO_MIME.get(ext) || 'application/octet-stream';
    if (buffer.length === 0 || buffer.length > MAX_ATTACHMENT_BYTES) {
      return { skipped: true, reason: 'empty or oversized inline payload' };
    }
    return { buffer, mime, name };
  }

  // 3. Local `file://...` URI (only regular files within MAX_ATTACHMENT_BYTES; skip secrets)
  if (uri.startsWith('file://')) {
    try {
      const localPath = fileURLToPath(uri);
      if (isSensitiveAttachmentName(localPath)) {
        return { skipped: true, reason: 'refused to materialize sensitive file attachment' };
      }
      const stat = fs.lstatSync(localPath);
      if (stat.isSymbolicLink() || !stat.isFile()) return null;
      if (stat.size <= 0 || stat.size > MAX_ATTACHMENT_BYTES) {
        return { skipped: true, reason: 'file attachment empty or oversized' };
      }
      const buffer = fs.readFileSync(localPath);
      const ext = path.extname(name || localPath).toLowerCase();
      mime = mime || EXT_TO_MIME.get(ext) || 'application/octet-stream';
      return { buffer, mime, name: name || path.basename(localPath) };
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Create a Blackboard manager bound to a root directory (defaults to `/tmp/opencode/blackboard`).
 * All operations are synchronous, bounded, symlink-safe, and fail-safe for plugin hooks.
 */
export function createBlackboardManager(options = {}) {
  const baseDir = options.baseDir ? path.resolve(options.baseDir) : resolveBlackboardRoot();
  const clock = typeof options.clock === 'function' ? options.clock : () => new Date();

  function boardDir(rootSessionID) {
    const safeID = sanitizeSessionID(rootSessionID);
    if (!safeID) throw new Error(`invalid rootSessionID: ${String(rootSessionID)}`);
    return path.join(baseDir, safeID);
  }

  function manifestPath(rootSessionID) {
    return path.join(boardDir(rootSessionID), 'manifest.json');
  }

  function exists(rootSessionID) {
    const safeID = sanitizeSessionID(rootSessionID);
    if (!safeID) return false;
    return fs.existsSync(path.join(baseDir, safeID, 'manifest.json'));
  }

  function createEmptyManifest(rootSessionID, directory = null) {
    const now = clock().toISOString();
    return {
      version: 1,
      rootSessionID,
      directory: directory ?? null,
      createdAt: now,
      updatedAt: now,
      sessions: {},
      attachments: [],
      reports: [],
      fileOwnership: {},
      failedAttempts: [],
    };
  }

  function readManifest(rootSessionID) {
    const safeID = sanitizeSessionID(rootSessionID);
    if (!safeID) return null;
    const file = path.join(baseDir, safeID, 'manifest.json');
    if (!fs.existsSync(file)) return null;
    try {
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink() || !stat.isFile()) return null;
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!parsed || typeof parsed !== 'object') return null;
      return parsed;
    } catch {
      return null;
    }
  }

  function ensureBoard(rootSessionID, directory = null) {
    const safeID = sanitizeSessionID(rootSessionID);
    if (!safeID) return null;
    ensurePrivateDir(baseDir);
    const dir = path.join(baseDir, safeID);
    ensurePrivateDir(dir);
    ensurePrivateDir(path.join(dir, 'attachments'));
    ensurePrivateDir(path.join(dir, 'reports'));

    let manifest = readManifest(safeID);
    if (!manifest) {
      manifest = createEmptyManifest(safeID, directory);
      atomicWritePrivate(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    } else if (directory && !manifest.directory) {
      manifest.directory = directory;
      manifest.updatedAt = clock().toISOString();
      atomicWritePrivate(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    }
    return manifest;
  }

  function mutateManifest(rootSessionID, directory, mutator) {
    const safeID = sanitizeSessionID(rootSessionID);
    if (!safeID) return null;
    const manifest = ensureBoard(safeID, directory);
    if (!manifest) return null;
    const changed = mutator(manifest);
    if (changed !== false) {
      manifest.updatedAt = clock().toISOString();
      atomicWritePrivate(manifestPath(safeID), `${JSON.stringify(manifest, null, 2)}\n`);
    }
    return manifest;
  }

  /** Auto-materialize user-attached photos/PDFs/files to stable paths in `attachments/`. */
  function materializeAttachments({ rootSessionID, messageID = null, files = [], directory = null }) {
    if (!Array.isArray(files) || files.length === 0) return [];
    const safeID = sanitizeSessionID(rootSessionID);
    if (!safeID) return [];

    const decodedItems = [];
    for (const file of files) {
      if (decodedItems.length >= MAX_ATTACHMENTS) break;
      const decoded = decodeAttachmentPayload(file);
      if (!decoded || decoded.skipped || !decoded.buffer) continue;
      decodedItems.push(decoded);
    }
    if (decodedItems.length === 0) return [];

    const materialized = [];
    mutateManifest(safeID, directory, (manifest) => {
      if (!Array.isArray(manifest.attachments)) manifest.attachments = [];
      let changed = false;

      for (const decoded of decodedItems) {
        if (manifest.attachments.length >= MAX_ATTACHMENTS) break;

        const sha256 = crypto.createHash('sha256').update(decoded.buffer).digest('hex');
        const existing = manifest.attachments.find((item) => item.sha256 === sha256);
        if (existing && fs.existsSync(existing.path)) {
          materialized.push(existing);
          continue;
        }

        const seq = manifest.attachments.length + 1;
        const ext = MIME_TO_EXT.get(decoded.mime) || path.extname(decoded.name || '') || '.bin';
        const safeName = sanitizeFilename(decoded.name || `attachment-${seq}${ext}`, ext);
        const targetName = `${String(seq).padStart(3, '0')}-${safeName}`;
        const targetPath = path.join(boardDir(safeID), 'attachments', targetName);

        atomicWritePrivate(targetPath, decoded.buffer);
        const entry = {
          seq,
          name: decoded.name || safeName,
          mime: decoded.mime,
          bytes: decoded.buffer.length,
          sha256,
          path: targetPath,
          messageID: messageID ?? null,
          createdAt: clock().toISOString(),
        };
        manifest.attachments.push(entry);
        materialized.push(entry);
        changed = true;
      }
      return changed;
    });

    return materialized;
  }

  /** Record a newly spawned subagent in the Blackboard manifest. */
  function recordSubagentSpawn({ rootSessionID, childSessionID, agent, description, directory = null }) {
    const safeRoot = sanitizeSessionID(rootSessionID);
    const safeChild = sanitizeSessionID(childSessionID);
    if (!safeRoot || !safeChild) return null;
    return mutateManifest(safeRoot, directory, (manifest) => {
      if (!manifest.sessions || typeof manifest.sessions !== 'object') manifest.sessions = {};
      manifest.sessions[safeChild] = {
        agent: String(agent || 'subagent'),
        description: redactString(String(description || ''), { maxLength: 200 }),
        status: 'running',
        spawnedAt: clock().toISOString(),
        completedAt: null,
      };
      return true;
    });
  }

  /**
   * Validate and store a versioned subagent report in `reports/`.
   * If output is empty or malformed (e.g. DeepSeek DSML tags), attaches real `git status --short`
   * and returns `{ validation, report, fallbackNotice }`.
   */
  function recordSubagentReport({
    rootSessionID,
    sessionID,
    agent = 'subagent',
    description = '',
    text = '',
    status = 'completed',
    directory = null,
    error = null,
  }) {
    const safeRoot = sanitizeSessionID(rootSessionID);
    const safeChild = sanitizeSessionID(sessionID) || 'unknown';
    if (!safeRoot) return null;

    const validation = status === 'error'
      ? { valid: false, issue: 'error', detail: redactString(String(error || 'subagent tool error'), { maxLength: 300 }) }
      : validateSubagentOutput(text);

    const safeAgent = sanitizeFilename(agent || 'subagent', '').replace(/\.+$/, '') || 'subagent';
    const redactedBody = redactString(String(text || ''), { maxLength: MAX_REPORT_CHARS });
    const redactedDesc = singleLine(description, 200);
    const contentHash = crypto
      .createHash('sha256')
      .update(`${status}:${validation.issue ?? 'ok'}:${redactedBody}`)
      .digest('hex')
      .slice(0, 16);

    // Check dedupe BEFORE running `git status --short` so repeated session.context calls
    // never spawn redundant git subprocesses!
    const existingManifest = readManifest(safeRoot);
    const existingDup = existingManifest?.reports?.find(
      (r) => r.sessionID === safeChild && r.contentHash === contentHash,
    );
    if (existingDup) {
      const fallbackNotice = !validation.valid
        ? [
            `[Blackboard validation warning: child ${safeAgent} (${safeChild}) returned ${validation.issue} — ${validation.detail}]`,
            `Exit/state: ${status}`,
            existingDup.gitStatus ? `Workspace git status --short:\n${existingDup.gitStatus}` : '',
            existingDup.path ? `Diagnostic report saved: ${existingDup.path}` : '',
          ]
            .filter(Boolean)
            .join('\n')
        : null;
      return { validation, report: existingDup, fallback: null, fallbackNotice, deduplicated: true };
    }

    const effectiveDir = directory || existingManifest?.directory || null;
    const fallback = !validation.valid ? collectWorkspaceFallbackState(effectiveDir) : null;

    let savedReport = null;
    mutateManifest(safeRoot, effectiveDir, (manifest) => {
      if (!Array.isArray(manifest.reports)) manifest.reports = [];

      const duplicate = manifest.reports.find(
        (r) => r.sessionID === safeChild && r.contentHash === contentHash,
      );
      if (duplicate) {
        savedReport = duplicate;
        return false;
      }

      const seq = (manifest.reports.reduce((m, r) => Math.max(m, Number(r.seq) || 0), 0)) + 1;
      const reportFile = path.join(
        boardDir(safeRoot),
        'reports',
        `${String(seq).padStart(3, '0')}-${safeAgent}-${safeChild}.md`,
      );

      const reportLines = [
        `# Subagent Report #${seq} (${safeAgent})`,
        `- Session: \`${safeChild}\``,
        `- Status: \`${validation.valid ? status : validation.issue}\``,
      ];
      if (redactedDesc) reportLines.push(`- Task: ${redactedDesc}`);
      reportLines.push(`- Recorded: ${clock().toISOString()}`);
      reportLines.push('');
      if (validation.valid) {
        reportLines.push(redactedBody);
      } else {
        reportLines.push(`> WARNING: ${validation.detail}`);
        if (fallback) {
          reportLines.push('');
          reportLines.push('## Workspace `git status --short`');
          reportLines.push('```');
          reportLines.push(fallback.ok ? fallback.gitStatus : `(git status failed: ${fallback.error})`);
          reportLines.push('```');
        }
        if (redactedBody.trim().length > 0) {
          reportLines.push('');
          reportLines.push('## Raw Output Excerpt');
          reportLines.push(redactedBody.slice(0, 2000));
        }
      }

      atomicWritePrivate(reportFile, `${reportLines.join('\n')}\n`);

      const firstNonEmptyLine = redactedBody
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l.length > 0 && !l.startsWith('```')) || '';

      savedReport = {
        seq,
        sessionID: safeChild,
        agent: safeAgent,
        description: redactedDesc,
        status: validation.valid ? status : validation.issue,
        valid: validation.valid,
        issue: validation.issue,
        path: reportFile,
        gitStatus: fallback?.ok ? fallback.gitStatus : null,
        summary: singleLine(
          validation.valid ? firstNonEmptyLine : `${validation.detail}${fallback?.ok ? `; git: ${fallback.gitStatus.split('\n').slice(0, 3).join(', ')}` : ''}`,
          160,
        ),
        contentHash,
        createdAt: clock().toISOString(),
      };

      manifest.reports.push(savedReport);
      while (manifest.reports.length > MAX_REPORTS) manifest.reports.shift();

      if (!manifest.sessions || typeof manifest.sessions !== 'object') manifest.sessions = {};
      manifest.sessions[safeChild] = {
        ...(manifest.sessions[safeChild] ?? {}),
        agent: safeAgent,
        description: redactedDesc || manifest.sessions[safeChild]?.description || '',
        status: savedReport.status,
        completedAt: clock().toISOString(),
      };

      if (!validation.valid) {
        if (!Array.isArray(manifest.failedAttempts)) manifest.failedAttempts = [];
        manifest.failedAttempts.push({
          sessionID: safeChild,
          agent: safeAgent,
          tool: 'subagent',
          summary: redactString(validation.detail, { maxLength: 180 }),
          at: clock().toISOString(),
        });
        while (manifest.failedAttempts.length > MAX_FAILED_ATTEMPTS) manifest.failedAttempts.shift();
      }
      return true;
    });

    const fallbackNotice = !validation.valid
      ? [
          `[Blackboard validation warning: child ${safeAgent} (${safeChild}) returned ${validation.issue} — ${validation.detail}]`,
          `Exit/state: ${status}`,
          `Workspace git status --short:\n${fallback?.ok ? fallback.gitStatus : `(unavailable: ${fallback?.error ?? 'unknown'})`}`,
          savedReport?.path ? `Diagnostic report saved: ${savedReport.path}` : '',
        ]
          .filter(Boolean)
          .join('\n')
      : null;

    return { validation, report: savedReport, fallback, fallbackNotice };
  }

  /** Record files edited/written by a session (only when a Blackboard is active for rootSessionID). */
  function recordFileOwnership({ rootSessionID, sessionID, agent = 'unknown', filePaths = [], directory = null }) {
    const safeRoot = sanitizeSessionID(rootSessionID);
    if (!safeRoot || !exists(safeRoot)) return null;
    const validPaths = filePaths.filter((p) => typeof p === 'string' && p.trim().length > 0);
    if (validPaths.length === 0) return null;

    return mutateManifest(safeRoot, directory, (manifest) => {
      if (!manifest.fileOwnership || typeof manifest.fileOwnership !== 'object') {
        manifest.fileOwnership = {};
      }
      const now = clock().toISOString();
      for (const raw of validPaths) {
        const key = redactString(raw.trim(), { maxLength: 200 });
        manifest.fileOwnership[key] = {
          sessionID: String(sessionID || safeRoot),
          agent: String(agent || 'unknown'),
          updatedAt: now,
        };
      }
      const keys = Object.keys(manifest.fileOwnership);
      if (keys.length > MAX_FILE_OWNERSHIP) {
        const sorted = keys.sort(
          (a, b) =>
            String(manifest.fileOwnership[a]?.updatedAt || '').localeCompare(
              String(manifest.fileOwnership[b]?.updatedAt || ''),
            ),
        );
        for (const oldKey of sorted.slice(0, keys.length - MAX_FILE_OWNERSHIP)) {
          delete manifest.fileOwnership[oldKey];
        }
      }
      return true;
    });
  }

  /** Record a failed tool/subagent attempt (only when a Blackboard is active for rootSessionID). */
  function recordFailedAttempt({ rootSessionID, sessionID, agent = 'unknown', tool = 'tool', summary = '', directory = null }) {
    const safeRoot = sanitizeSessionID(rootSessionID);
    if (!safeRoot || !exists(safeRoot)) return null;
    const cleanedSummary = redactString(String(summary || 'error'), { maxLength: 180 });
    return mutateManifest(safeRoot, directory, (manifest) => {
      if (!Array.isArray(manifest.failedAttempts)) manifest.failedAttempts = [];
      manifest.failedAttempts.push({
        sessionID: String(sessionID || safeRoot),
        agent: String(agent || 'unknown'),
        tool: String(tool || 'tool'),
        summary: cleanedSummary,
        at: clock().toISOString(),
      });
      while (manifest.failedAttempts.length > MAX_FAILED_ATTEMPTS) manifest.failedAttempts.shift();
      return true;
    });
  }

  /**
   * Build a compact (~150-250 token, <= 1,200 char) Blackboard pointer block
   * injected into subagent spawns and child contexts.
   */
  function buildPointerBlock(rootSessionID) {
    const safeRoot = sanitizeSessionID(rootSessionID);
    if (!safeRoot) return '';
    const manifest = readManifest(safeRoot);
    if (!manifest) return '';

    const dir = boardDir(safeRoot);
    const lines = [
      BLACKBOARD_MARKER,
      `Shared Blackboard: \`${dir}/manifest.json\``,
    ];

    const attachments = Array.isArray(manifest.attachments) ? manifest.attachments : [];
    if (attachments.length > 0) {
      const items = attachments
        .slice(-6)
        .map((a) => `${singleLine(a.name, 80)} (${singleLine(a.mime, 40)}): \`${singleLine(a.path, 200)}\``)
        .join('; ');
      lines.push(`User attachments (read directly via file tools): ${items}`);
    }

    const reports = Array.isArray(manifest.reports) ? manifest.reports : [];
    if (reports.length > 0) {
      const items = reports
        .slice(-5)
        .map((r) => `#${r.seq} ${singleLine(r.agent, 40)}[${singleLine(r.status, 30)}]: \`${singleLine(r.path, 200)}\``)
        .join('; ');
      lines.push(`Sibling reports: ${items}`);
    }

    const ownership = manifest.fileOwnership && typeof manifest.fileOwnership === 'object'
      ? Object.entries(manifest.fileOwnership)
      : [];
    if (ownership.length > 0) {
      const items = ownership
        .slice(-8)
        .map(([file, info]) => `${singleLine(file, 120)} (${singleLine(info.agent, 40)})`)
        .join(', ');
      lines.push(`Recent file edits: ${items}`);
    }

    const failures = Array.isArray(manifest.failedAttempts) ? manifest.failedAttempts : [];
    if (failures.length > 0) {
      const items = failures
        .slice(-3)
        .map((f) => `${singleLine(f.agent, 40)}/${singleLine(f.tool, 40)}: ${singleLine(f.summary, 80)}`)
        .join('; ');
      lines.push(`Recent failures (avoid repeating): ${items}`);
    }

    lines.push(BLACKBOARD_MARKER);
    let block = lines.join('\n');
    if (block.length > MAX_POINTER_CHARS) {
      const budget = MAX_POINTER_CHARS - BLACKBOARD_MARKER.length - 12;
      block = `${block.slice(0, budget)}…\n${BLACKBOARD_MARKER}`;
    }
    return block;
  }

  /** Idempotently inject/refresh the compact Blackboard pointer in a subagent prompt string. */
  function injectIntoPrompt(prompt, rootSessionID) {
    if (typeof prompt !== 'string') return prompt;
    const pointer = buildPointerBlock(rootSessionID);
    if (!pointer) return prompt;
    const blockRegex = new RegExp(`${BLACKBOARD_MARKER}[\\s\\S]*?${BLACKBOARD_MARKER}`, 'g');
    if (blockRegex.test(prompt)) {
      // Use replacer function so `$&`, `` $` ``, `$'`, `$1` inside failure/attachment text never corrupt prompt!
      return prompt.replace(blockRegex, () => pointer);
    }
    return `${prompt}\n\n${pointer}`;
  }

  /** Idempotently inject/refresh the compact Blackboard pointer into `session.context` system parts. */
  function injectIntoSystemParts(systemParts, rootSessionID) {
    if (!Array.isArray(systemParts)) return false;
    const pointer = buildPointerBlock(rootSessionID);
    if (!pointer) return false;
    const existingIdx = systemParts.findIndex(
      (part) => typeof part?.text === 'string' && part.text.includes(BLACKBOARD_MARKER),
    );
    if (existingIdx >= 0) {
      systemParts[existingIdx] = { ...systemParts[existingIdx], text: pointer };
    } else {
      systemParts.push({ text: pointer });
    }
    return true;
  }

  return {
    baseDir,
    boardDir,
    manifestPath,
    exists,
    ensureBoard,
    readManifest,
    materializeAttachments,
    recordSubagentSpawn,
    recordSubagentReport,
    recordFileOwnership,
    recordFailedAttempt,
    buildPointerBlock,
    injectIntoPrompt,
    injectIntoSystemParts,
  };
}
