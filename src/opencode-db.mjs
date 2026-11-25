// Strictly read-only SQLite reader for OpenCode v2's `opencode.db`.
// Provides authoritative session, model, cost, and workspace metrics to complement the JSONL
// audit trail in `src/rsi-prune.mjs` and `src/memory-consolidate.mjs`.
//
// Never opens the database read-write, never creates files, and degrades gracefully if the DB
// does not exist, is locked/corrupt, or lacks a table.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

export const OPENCODE_DB_ENV = "OPENCODE_DB_PATH";
const MAX_LOOKUP_SESSIONS = 10_000;
const EPHEMERAL_CHAT_PATTERN = /\/\.config\/openchamber\/chats(?:\/|$)/i;

function normalizePath(value) {
  if (typeof value !== "string" || value.length === 0) return "";
  return value.replace(/\\/g, "/").replace(/\/+$/g, "");
}

function isAbsoluteFsPath(value) {
  return value.startsWith("/") || /^[A-Za-z]:\//u.test(value);
}

function canonicalPath(value) {
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

function pathMatchesWorkspace(candidate, workspace) {
  if (!workspace) return true;
  if (!candidate) return false;
  const left = canonicalPath(candidate);
  const right = canonicalPath(workspace);
  if (!left || !right) return false;
  if (left === right) return true;
  if (right === "/") return isAbsoluteFsPath(left);
  if (left.startsWith(`${right}/`)) return true;
  if (right.startsWith(`${left}/`)) return false;
  if (isAbsoluteFsPath(left) !== isAbsoluteFsPath(right)) return false;
  if (isAbsoluteFsPath(left)) return false;
  return basename(left) === basename(right);
}

/**
 * Derive a clean project label from a workspace directory.
 * Ephemeral OpenChamber ad-hoc chat directories (`~/.config/openchamber/chats/...`) collapse
 * into one `"openchamber-chat"` bucket so ad-hoc chats never inflate distinct project counts
 * in the RSI catastrophic-forgetting guard.
 */
export function projectLabelFromWorkspace(workspacePath) {
  const canonical = canonicalPath(workspacePath);
  if (!canonical) return "unknown";
  if (EPHEMERAL_CHAT_PATTERN.test(canonical)) return "openchamber-chat";
  const label = basename(canonical);
  return label || "unknown";
}

/** Resolve the default OpenCode SQLite database path without touching disk. */
export function resolveOpenCodeDbPath(env = process.env) {
  const configured = env?.[OPENCODE_DB_ENV];
  if (typeof configured === "string" && configured.trim().length > 0) {
    return resolve(configured.trim());
  }
  const dataHome = env?.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(dataHome, "opencode", "opencode.db");
}

/** Normalize a JSON-encoded or plain-string model field to `provider/model`. */
export function normalizeDbModel(raw) {
  if (!raw) return "";
  let value = raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return "";
    if (trimmed.startsWith("{")) {
      try {
        value = JSON.parse(trimmed);
      } catch {
        return trimmed;
      }
    } else {
      return trimmed;
    }
  }
  if (value && typeof value === "object") {
    const provider = typeof value.providerID === "string"
      ? value.providerID.trim()
      : typeof value.provider === "string"
        ? value.provider.trim()
        : "";
    const id = typeof value.id === "string"
      ? value.id.trim()
      : typeof value.modelID === "string"
        ? value.modelID.trim()
        : typeof value.model === "string"
          ? value.model.trim()
          : "";
    if (!id) return "";
    return provider && !id.startsWith(`${provider}/`) ? `${provider}/${id}` : id;
  }
  return "";
}

function emptyResult(dbPath, error = null) {
  return {
    available: false,
    dbPath,
    error,
    sessions: [],
    models: [],
    projects: [],
    totalCostUSD: 0,
    sessionCount: 0,
    sessionDirectoryMap: new Map(),
    sessionModelMap: new Map(),
    sessionParentMap: new Map(),
  };
}

let sqliteModulePromise = null;
async function loadSqlite() {
  if (!sqliteModulePromise) {
    sqliteModulePromise = import("node:sqlite").catch(() => null);
  }
  return sqliteModulePromise;
}

/**
 * Synchronous read-only snapshot of OpenCode's SQLite database.
 * Uses `node:sqlite` (`DatabaseSync` in `{ readOnly: true }` mode).
 */
export async function readOpenCodeDbMetrics({
  dbPath,
  workspace = null,
  days = 7,
  now = Date.now(),
  env = process.env,
} = {}) {
  if (dbPath === false || dbPath === null) {
    return emptyResult("", null);
  }
  const resolvedPath = typeof dbPath === "string" && dbPath.trim().length > 0
    ? resolve(dbPath.trim())
    : resolveOpenCodeDbPath(env);

  if (!existsSync(resolvedPath)) {
    return emptyResult(resolvedPath, null);
  }

  const sqlite = await loadSqlite();
  if (!sqlite || typeof sqlite.DatabaseSync !== "function") {
    return emptyResult(resolvedPath, "node:sqlite is unavailable in this Node runtime");
  }

  const cutoff = Number.isFinite(Number(days)) && Number(days) > 0
    ? Number(now) - Number(days) * 86_400_000
    : -Infinity;

  let db = null;
  try {
    db = new sqlite.DatabaseSync(resolvedPath, { readOnly: true });
    const tables = new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => String(row.name)),
    );

    const hasSessionV2 = tables.has("session_v2");
    const hasSessionV1 = tables.has("session");
    const hasProject = tables.has("project");
    const hasSessionMessage = tables.has("session_message");

    if (!hasSessionV2 && !hasSessionV1) {
      return emptyResult(resolvedPath, null);
    }

    const sessionTable = hasSessionV2 ? "session_v2" : "session";
    const selectSessionsSql = hasProject
      ? `SELECT s.id, s.project_id, s.parent_id, s.directory, p.worktree, s.title, s.cost,
                s.tokens_input, s.tokens_output, s.tokens_reasoning, s.tokens_cache_read, s.tokens_cache_write,
                s.agent, s.model, s.time_created, s.time_updated
         FROM ${sessionTable} s
         LEFT JOIN project p ON p.id = s.project_id
         ORDER BY s.time_updated DESC
         LIMIT ?`
      : `SELECT s.id, s.project_id, s.parent_id, s.directory, NULL AS worktree, s.title, s.cost,
                s.tokens_input, s.tokens_output, s.tokens_reasoning, s.tokens_cache_read, s.tokens_cache_write,
                s.agent, s.model, s.time_created, s.time_updated
         FROM ${sessionTable} s
         ORDER BY s.time_updated DESC
         LIMIT ?`;

    const allRows = db.prepare(selectSessionsSql).all(MAX_LOOKUP_SESSIONS);

    const sessionDirectoryMap = new Map();
    const sessionModelMap = new Map();
    const sessionParentMap = new Map();
    const sessionsInWindow = [];
    const sessionIndex = new Map();

    for (const row of allRows) {
      const id = String(row.id ?? "");
      if (!id) continue;
      const dir = normalizePath(String(row.directory || row.worktree || ""));
      const model = normalizeDbModel(row.model);
      if (dir) sessionDirectoryMap.set(id, dir);
      if (model) sessionModelMap.set(id, model);
      if (row.parent_id) sessionParentMap.set(id, String(row.parent_id));

      const updated = Number(row.time_updated ?? row.time_created ?? 0);
      const created = Number(row.time_created ?? updated);
      if (Number.isFinite(updated) && updated < cutoff) continue;
      if (workspace && !pathMatchesWorkspace(dir, workspace)) continue;

      const project = projectLabelFromWorkspace(dir);
      const costNum = Number(row.cost ?? 0);
      const item = {
        id,
        parentId: row.parent_id ? String(row.parent_id) : null,
        directory: dir,
        project,
        title: typeof row.title === "string" ? row.title : "",
        agent: typeof row.agent === "string" ? row.agent : "",
        model,
        costUSD: Number.isFinite(costNum) ? costNum : 0,
        tokens: {
          input: Number(row.tokens_input ?? 0) || 0,
          output: Number(row.tokens_output ?? 0) || 0,
          reasoning: Number(row.tokens_reasoning ?? 0) || 0,
          cacheRead: Number(row.tokens_cache_read ?? 0) || 0,
          cacheWrite: Number(row.tokens_cache_write ?? 0) || 0,
        },
        timeCreated: created,
        timeUpdated: updated,
      };
      sessionsInWindow.push(item);
      sessionIndex.set(id, item);
    }

    // Aggregate per-model turns, cost, errors, sessions, and projects from `session_message`.
    const modelStats = new Map();
    if (hasSessionMessage) {
      const msgRows = db
        .prepare(
          `SELECT session_id, time_created, data
           FROM session_message
           WHERE type = 'assistant' AND time_created >= ? AND time_created <= ?`,
        )
        .all(Number.isFinite(cutoff) ? Math.floor(cutoff) : 0, Math.floor(now) + 86_400_000);

      for (const row of msgRows) {
        const sid = String(row.session_id ?? "");
        const dir = sessionDirectoryMap.get(sid) ?? "";
        if (workspace && !pathMatchesWorkspace(dir, workspace)) continue;
        let parsed;
        try {
          parsed = JSON.parse(String(row.data ?? ""));
        } catch {
          continue;
        }
        const model = normalizeDbModel(parsed?.model) || sessionModelMap.get(sid) || "";
        if (!model) continue;

        // Also backfill sessionModelMap if session row lacked a model.
        if (sid && !sessionModelMap.has(sid)) sessionModelMap.set(sid, model);

        const cost = Number(parsed?.cost ?? 0);
        const safeCost = Number.isFinite(cost) ? cost : 0;
        const isError = Boolean(parsed?.error) || parsed?.finish === "error";
        const project = projectLabelFromWorkspace(dir);

        let stat = modelStats.get(model);
        if (!stat) {
          stat = {
            model,
            turns: 0,
            costUSD: 0,
            errors: 0,
            sessions: new Set(),
            projects: new Set(),
          };
          modelStats.set(model, stat);
        }
        stat.turns += 1;
        stat.costUSD += safeCost;
        if (isError) stat.errors += 1;
        if (sid) {
          const rootSid = sessionParentMap.get(sid) || sid;
          stat.sessions.add(`${project}\u0000${rootSid}`);
          if (project && project !== "unknown" && project !== "openchamber-chat") {
            stat.projects.add(project);
          }
        }
      }
    } else {
      // Fallback when `session_message` does not exist (e.g. minimal fixture DB): derive from sessions.
      for (const s of sessionsInWindow) {
        if (!s.model) continue;
        let stat = modelStats.get(s.model);
        if (!stat) {
          stat = {
            model: s.model,
            turns: 0,
            costUSD: 0,
            errors: 0,
            sessions: new Set(),
            projects: new Set(),
          };
          modelStats.set(s.model, stat);
        }
        stat.turns += 1;
        stat.costUSD += s.costUSD;
        stat.sessions.add(`${s.project}\u0000${s.id}`);
        if (s.project && s.project !== "unknown") stat.projects.add(s.project);
      }
    }

    const projectMap = new Map();
    for (const s of sessionsInWindow) {
      let stat = projectMap.get(s.project);
      if (!stat) {
        stat = { project: s.project, sessions: new Set(), costUSD: 0, directories: new Set() };
        projectMap.set(s.project, stat);
      }
      stat.sessions.add(s.id);
      stat.costUSD += s.costUSD;
      if (s.directory) stat.directories.add(s.directory);
    }

    const totalCostUSD = Number(
      sessionsInWindow.reduce((sum, s) => sum + s.costUSD, 0).toFixed(4),
    );

    const models = [...modelStats.values()]
      .map((stat) => ({
        model: stat.model,
        turns: stat.turns,
        costUSD: Number(stat.costUSD.toFixed(4)),
        avgCostPerTurnUSD: stat.turns ? Number((stat.costUSD / stat.turns).toFixed(4)) : 0,
        errors: stat.errors,
        errorRate: stat.turns ? stat.errors / stat.turns : 0,
        evidence: {
          distinctProjects: stat.projects.size,
          sessions: stat.sessions.size,
        },
        _projects: stat.projects,
        _sessions: stat.sessions,
      }))
      .sort((a, b) => b.costUSD - a.costUSD || b.turns - a.turns || a.model.localeCompare(b.model));

    const projects = [...projectMap.values()]
      .map((stat) => ({
        project: stat.project,
        sessions: stat.sessions.size,
        sessionIds: stat.sessions,
        costUSD: Number(stat.costUSD.toFixed(4)),
        directories: [...stat.directories].sort(),
      }))
      .sort((a, b) => b.costUSD - a.costUSD || b.sessions - a.sessions || a.project.localeCompare(b.project));

    return {
      available: true,
      dbPath: resolvedPath,
      error: null,
      sessions: sessionsInWindow,
      models,
      projects,
      totalCostUSD,
      sessionCount: sessionsInWindow.length,
      sessionDirectoryMap,
      sessionModelMap,
      sessionParentMap,
    };
  } catch (error) {
    return emptyResult(resolvedPath, String(error?.message ?? error));
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        // ignore
      }
    }
  }
}
