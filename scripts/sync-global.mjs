// Global sync for OpenCode v2. Copies this repository's canonical config into the target config
// directory, retires legacy v1 files into v1-disabled/ (never deletes them), and rotates an exposed
// service.json. It is deliberately inert until called; Wave 3 runs it against ~/.config/opencode.

import {
  closeSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, parse, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/**
 * Trees this script must never write, move or delete inside: Pi's own configuration and
 * pi-workflow-tools are explicitly out of bounds (OCW-08), and the source repository is the wrong
 * destination for a *global* OpenCode sync. Both the literal path and its realpath are checked, so
 * a symlink pointing into either tree is refused as well.
 */
const FORBIDDEN_TARGETS = Object.freeze([
  resolve("/root/.pi"),
  resolve("/root/pi-projects/pi-workflow-tools"),
  REPO_ROOT,
]);

export const LEGACY_V1_FILES = Object.freeze([
  "herdr-agent-state.js",
  "tui.jsonc",
  "herdr-tui-session.js",
  "package.json",
  "package-lock.json",
  "plugins/herdr-agent-state.js",
]);

export const SYNCED_FILES = Object.freeze([
  { source: "config/opencode.jsonc", target: "opencode.jsonc" },
  { source: "config/AGENTS.md", target: "AGENTS.md" },
]);

function timestamp(now) {
  return new Date(now).toISOString().replace(/[:.]/g, "-");
}

function freePath(path, exists = existsSync) {
  if (!exists(path)) return path;
  const dir = dirname(path);
  const name = basename(path);
  for (let index = 1; index < 1000; index += 1) {
    const candidate = join(dir, `${name}.${index}`);
    if (!exists(candidate)) return candidate;
  }
  throw new Error(`Unable to find a free backup name for ${path}`);
}

/** Maximum number of symlink hops a single resolution may follow before it is refused. */
export const MAX_SYMLINK_HOPS = 40;

/**
 * Resolves `path` to a canonical absolute path, following symlinks in every segment — including
 * the final leaf — and re-appending segments that do not exist yet.
 *
 * `realpathSync` throws on a *dangling* symlink, and the old fallback then re-appended the leaf
 * literally, so `target/link -> /root/.pi/missing/opencode.jsonc` resolved to `target/link` and
 * passed the forbidden-tree check while a write through it would land in Pi's tree. Walking
 * segment by segment with `lstatSync`/`readlinkSync` resolves the link target itself (even when it
 * does not exist yet), so safety decisions are made on the real destination. Symlink loops are
 * bounded by MAX_SYMLINK_HOPS.
 */
function realpathDeep(path) {
  const target = resolve(path);
  const { root } = parse(target);
  const pending = target.slice(root.length).split(sep).filter(Boolean);
  let current = root;
  let hops = 0;

  while (pending.length > 0) {
    const segment = pending.shift();
    const next = join(current, segment);
    let info;
    try {
      info = lstatSync(next);
    } catch {
      // Nothing exists from here on; the remaining segments are a literal (not-yet-created) path.
      return pending.length > 0 ? join(next, ...pending) : next;
    }
    if (info.isSymbolicLink()) {
      hops += 1;
      if (hops > MAX_SYMLINK_HOPS) {
        throw new Error(`Refusing to resolve a symlink chain deeper than ${MAX_SYMLINK_HOPS} hops: ${target}`);
      }
      const link = readlinkSync(next);
      const rebased = resolve(current, link);
      const { root: linkRoot } = parse(rebased);
      pending.unshift(...rebased.slice(linkRoot.length).split(sep).filter(Boolean));
      current = linkRoot;
      continue;
    }
    current = next;
  }
  return current;
}

function assertSafeTarget(targetDir) {
  const target = realpathDeep(targetDir);
  if (target === sep || target === resolve("/")) throw new Error("Refusing to sync into the filesystem root");
  for (const forbiddenPath of FORBIDDEN_TARGETS) {
    for (const forbidden of new Set([resolve(forbiddenPath), realpathDeep(forbiddenPath)])) {
      if (target === forbidden || target.startsWith(`${forbidden}${sep}`)) {
        throw new Error(`Refusing to sync into forbidden target: ${target}`);
      }
    }
  }
  return target;
}

/** Refuses a symlink at the write destination (the link itself is never replaced or followed). */
function assertNotSymlinkDestination(file) {
  let info = null;
  try {
    info = lstatSync(file);
  } catch {
    info = null;
  }
  if (info?.isSymbolicLink()) {
    throw new Error(`Refusing to replace a symlink at the sync destination: ${file}`);
  }
}

/**
 * Writes `content` to `file` through a temp file, without ever following a symlink.
 *
 * - The temp name is cryptographically random (`.<basename>.<32 hex>.tmp`), so a predictable
 *   `opencode.jsonc.tmp` symlink planted by an attacker is never opened, let alone written
 *   through.
 * - The temp file is created with `O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW`: exclusive creation
 *   fails on a pre-existing name and `O_NOFOLLOW` refuses a symlink at that name.
 * - The destination is `lstat`-checked (twice: before creating the temp file, and again right
 *   before `renameSync`) and must not be a symlink; `renameSync` itself replaces a link rather
 *   than following it, so a link that appears mid-write still cannot redirect the content.
 */
function atomicWrite(file, content) {
  mkdirSync(dirname(file), { recursive: true });
  assertNotSymlinkDestination(file);
  const tmp = join(dirname(file), `.${basename(file)}.${randomBytes(16).toString("hex")}.tmp`);
  const flags = fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW;
  try {
    const fd = openSync(tmp, flags, 0o644);
    try {
      writeSync(fd, content);
    } finally {
      closeSync(fd);
    }
    assertNotSymlinkDestination(file);
    renameSync(tmp, file);
  } catch (error) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best effort */ }
    throw error;
  }
}

function sameContents(left, right) {
  if (!existsSync(right)) return false;
  try {
    return readFileSync(left).equals(readFileSync(right));
  } catch {
    return false;
  }
}

/**
 * Synchronizes the repository's global config.
 *
 * @param {object} options
 * @param {string} [options.targetDir] Defaults to ~/.config/opencode.
 * @param {boolean} [options.dryRun=false]
 * @param {boolean} [options.skipServiceRotate=false]
 * @param {string} [options.sourceRoot] Repository root (test seam).
 * @param {number} [options.now=Date.now()]
 */
export function syncGlobal(options = {}) {
  const targetDir = assertSafeTarget(options.targetDir ?? join(homedir(), ".config", "opencode"));
  const sourceRoot = resolve(options.sourceRoot ?? REPO_ROOT);
  const dryRun = Boolean(options.dryRun);
  const skipServiceRotate = Boolean(options.skipServiceRotate);
  const now = options.now ?? Date.now();
  const stamp = timestamp(now);
  const exists = options.exists ?? existsSync;

  const actions = [];
  const changed = [];
  const skipped = [];

  // Every path inside the target is re-canonicalized before it is written, moved or deleted, so a
  // symlinked sub-directory cannot redirect a move/write outside the sync target (for example a
  // `v1-disabled` symlink pointing at /root/.pi).
  const ensureInsideTarget = (path) => {
    const canonical = realpathDeep(path);
    if (canonical !== targetDir && !canonical.startsWith(`${targetDir}${sep}`)) {
      throw new Error(`Refusing to write through a symlink outside the sync target: ${canonical}`);
    }
    return canonical;
  };

  // A write destination must be judged on its *lexical* path, never on its resolved referent:
  // `opencode.jsonc -> victim.json` resolves to an in-target path, so canonicalizing first would
  // silently overwrite `victim.json`. The link itself is refused and the lexical path is what gets
  // written. `ensureInsideTarget()` still runs first so a link escaping the target keeps reporting
  // the escape error.
  const ensureWriteDestination = (path) => {
    const canonical = ensureInsideTarget(path);
    let info = null;
    try {
      info = lstatSync(path);
    } catch {
      info = null;
    }
    if (info?.isSymbolicLink()) {
      throw new Error(`Refusing to replace a symlink at the sync destination: ${path} (resolves to ${canonical})`);
    }
    return path;
  };

  const ensureTarget = () => {
    if (exists(targetDir)) return;
    actions.push({ type: "mkdir", path: targetDir });
    changed.push({ type: "mkdir", path: targetDir });
    if (!dryRun) mkdirSync(targetDir, { recursive: true, mode: 0o755 });
  };
  ensureTarget();

  // 1. Rotate the exposed service credential file. Deleting it is the rotation: a fresh service
  //    creates a new password on next start. Never touch it when explicitly skipped.
  const servicePath = join(targetDir, "service.json");
  if (skipServiceRotate) {
    skipped.push({ type: "service-rotate", path: servicePath, reason: "--skip-service-rotate" });
  } else {
    ensureInsideTarget(servicePath);
    if (exists(servicePath)) {
      const info = statSync(servicePath);
      if (!info.isFile()) throw new Error(`Refusing to rotate non-file service path: ${servicePath}`);
      actions.push({ type: "rotate-service", path: servicePath });
      changed.push({ type: "rotate-service", path: servicePath });
      if (!dryRun) unlinkSync(servicePath);
    } else {
      skipped.push({ type: "service-rotate", path: servicePath, reason: "not present" });
    }
  }

  // 2. Move legacy v1 files aside. This is a move, never a delete, and collisions get suffixes.
  for (const relative of LEGACY_V1_FILES) {
    const source = ensureInsideTarget(join(targetDir, relative));
    if (!exists(source)) continue;
    const destinationBase = join(targetDir, "v1-disabled", relative);
    const destination = ensureInsideTarget(freePath(destinationBase, exists));
    actions.push({ type: "move-legacy", from: source, to: destination });
    changed.push({ type: "move-legacy", from: source, to: destination });
    if (!dryRun) {
      mkdirSync(dirname(destination), { recursive: true });
      renameSync(source, destination);
    }
  }

  // 3. Copy canonical config files. Back up a differing existing opencode.jsonc/AGENTS.md first.
  for (const item of SYNCED_FILES) {
    const source = join(sourceRoot, item.source);
    if (!exists(source)) throw new Error(`Canonical file missing: ${source}`);
    const destination = ensureWriteDestination(join(targetDir, item.target));
    if (sameContents(source, destination)) {
      skipped.push({ type: "copy", from: source, to: destination, reason: "already identical" });
      continue;
    }
    if (exists(destination)) {
      const backup = ensureInsideTarget(freePath(`${destination}.bak-${stamp}`, exists));
      actions.push({ type: "backup", from: destination, to: backup });
      changed.push({ type: "backup", from: destination, to: backup });
      if (!dryRun) copyFileSync(destination, backup);
    }
    actions.push({ type: "copy", from: source, to: destination });
    changed.push({ type: "copy", from: source, to: destination });
    if (!dryRun) atomicWrite(destination, readFileSync(source));
  }

  return {
    targetDir,
    sourceRoot,
    dryRun,
    skipServiceRotate,
    actions,
    changed,
    skipped,
    changedCount: changed.length,
  };
}

function parseCliArgs(argv) {
  const options = { skipServiceRotate: false, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${arg} requires a value`);
      return argv[i];
    };
    if (arg === "--target-dir") options.targetDir = next();
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--skip-service-rotate") options.skipServiceRotate = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function isMainModule() {
  const entry = process.argv[1];
  return Boolean(entry) && pathToFileURL(resolve(entry)).href === import.meta.url;
}

function main() {
  const options = parseCliArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node scripts/sync-global.mjs [--target-dir DIR] [--dry-run] [--skip-service-rotate]");
    return;
  }
  const result = syncGlobal(options);
  console.log(`${result.dryRun ? "DRY RUN — would sync" : "Synced"} to ${result.targetDir}`);
  for (const action of result.actions) {
    if (action.type === "copy") console.log(`  copy ${action.from} -> ${action.to}`);
    else if (action.type === "move-legacy") console.log(`  move legacy ${action.from} -> ${action.to}`);
    else if (action.type === "rotate-service") console.log(`  rotate service credentials: ${action.path}`);
    else if (action.type === "backup") console.log(`  backup ${action.from} -> ${action.to}`);
    else if (action.type === "mkdir") console.log(`  create ${action.path}`);
  }
  for (const item of result.skipped) console.log(`  skip ${item.type} ${item.path ?? item.to ?? ""}: ${item.reason}`);
  if (result.changedCount === 0) console.log("Nothing changed (already in sync).");
}

if (isMainModule()) {
  try {
    main();
  } catch (error) {
    console.error(`sync-global: ${error?.message ?? error}`);
    process.exitCode = 1;
  }
}

export const SYNC_INTERNALS = Object.freeze({ assertSafeTarget, freePath, timestamp, realpathDeep, FORBIDDEN_TARGETS });
