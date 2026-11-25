// Weekly recursive-self-improvement (RSI) pruner. This is a read-only reviewer: it reports
// tool/model/skill/permission/AGENTS.md evidence and proposed pruning, but it never edits live
// AGENTS.md or opencode.jsonc. Global pruning proposals are refused unless evidence spans at
// least two projects and five sessions, or the caller explicitly forces it (arXiv:2611.03219).

import {
  closeSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, parse, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createOpenRouterClientFromEnv, redactSecrets } from "./openrouter-client.mjs";
import { readOpenCodeDbMetrics } from "./opencode-db.mjs";
import {
  isAttributedSession,
  isToolStartType,
  isToolTerminalType,
  permissionDecisionRef,
  readAuditEntries,
  toolCallId,
} from "./memory-consolidate.mjs";

export const AGENTS_TARGET_CHARS = 2800;
export const AGENTS_HARD_CHARS = 3000;
export const DEFAULT_RSI_DAYS = 7;
export const MIN_DISTINCT_PROJECTS = 2;
export const MIN_TOTAL_SESSIONS = 5;
export const DEFAULT_SYNTHESIS_MODEL = "deepseek/deepseek-v4.1-flash-1017";
const TERRA_PATTERN = /gpt-6\.1-terra[\w.-]*/gi;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/**
 * Project labels that mean "could not be attributed" or ephemeral ad-hoc chats,
 * never real projects for the cross-project catastrophic-forgetting guard.
 */
const UNIDENTIFIED_PROJECTS = new Set(["", "unknown", "unattributed", "undefined", "null", "openchamber-chat"]);
/** Permission action names that mean "a shell command". */
const SHELL_ACTIONS = new Set(["bash", "shell", "execute"]);

function isIdentifiedProject(project) {
  return !UNIDENTIFIED_PROJECTS.has(String(project ?? "").trim().toLowerCase());
}

function entryType(entry) {
  return String(entry?.type ?? entry?.event ?? entry?.kind ?? entry?.name ?? entry?.data?.type ?? "").toLowerCase();
}

function entryTimestamp(entry) {
  return entry?.__timestamp ?? null;
}

function entrySession(entry) {
  // `__session` is "" for records that carry no session; `??` would keep that empty string.
  const value = entry?.__session || entry?.sessionID || entry?.sessionId || entry?.session?.id || entry?.data?.sessionID || "";
  return String(value || "unattributed");
}

function entryProject(entry) {
  return String(entry?.__project ?? entry?.project ?? entry?.projectId ?? entry?.projectID ?? entry?.data?.project ?? "unknown");
}

function entryModel(entry) {
  const value = entry?.model ?? entry?.__model ?? entry?.modelID ?? entry?.modelId ?? entry?.data?.model ?? entry?.data?.modelID ?? entry?.data?.modelId;
  if (typeof value === "string" && value) return value;
  // Compaction events forward the model as an object ({ providerID, modelID }) or as an id.
  if (value && typeof value === "object") {
    const provider = value.providerID ?? value.provider ?? entry?.providerID ?? entry?.data?.providerID;
    const id = value.modelID ?? value.modelId ?? value.id ?? value.model;
    if (typeof id === "string" && id) return typeof provider === "string" && provider ? `${provider}/${id}` : id;
  }
  const provider = entry?.providerID ?? entry?.data?.providerID;
  const id = entry?.modelID ?? entry?.data?.modelID ?? entry?.modelId ?? entry?.data?.modelId;
  if (typeof id === "string" && id) return typeof provider === "string" && provider ? `${provider}/${id}` : id;
  return "";
}

function entryCost(entry) {
  const value = entry?.cost ?? entry?.costUSD ?? entry?.usd ?? entry?.usage?.cost ?? entry?.data?.cost ?? entry?.data?.usage?.cost;
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function entryTool(entry, type) {
  const value = entry?.tool ?? entry?.toolName ?? entry?.data?.tool ?? entry?.data?.toolName ?? entry?.data?.name;
  if (typeof value === "string" && value) return value;
  if (type.includes("tool")) return String(entry?.data?.id ?? "tool");
  return "";
}

function entryError(entry, type) {
  if (/failed|failure|error|exception|interrupted/.test(type)) return true;
  if (entry?.error || entry?.errorMessage || entry?.data?.error) return true;
  const outcome = String(entry?.outcome ?? entry?.status ?? entry?.data?.outcome ?? "").toLowerCase();
  return outcome === "error" || outcome === "failed" || outcome === "failure";
}

function entrySkill(entry) {
  const value = entry?.skill ?? entry?.skillId ?? entry?.data?.skill ?? entry?.data?.skillId;
  return typeof value === "string" ? value : "";
}

function resourceLabel(value) {
  if (typeof value === "string" && value) return value;
  if (value && typeof value === "object") {
    for (const key of ["resource", "path", "pattern", "command", "name", "id", "value"]) {
      const candidate = value[key];
      if (typeof candidate === "string" && candidate) return candidate;
    }
  }
  return "";
}

/**
 * Every resource a permission decision covers. The Wave 2B plugin emits `resources: [...]` on
 * `permission.evaluate`/`permission.asked` (and the action name separately), so the single-value
 * fallbacks below only apply to older or synthetic records.
 */
export function entryResources(entry) {
  const list = entry?.resources ?? entry?.data?.resources;
  const labels = [];
  if (Array.isArray(list)) {
    for (const item of list) {
      const label = resourceLabel(item);
      if (label) labels.push(label);
    }
  } else {
    const label = resourceLabel(list);
    if (label) labels.push(label);
  }
  if (labels.length) return labels;
  const fallback = entryResource(entry);
  return fallback ? [fallback] : [];
}

function entryResource(entry) {
  const value =
    entry?.resource ?? entry?.action ?? entry?.data?.resource ?? entry?.data?.action ??
    entry?.input?.command ?? entry?.input?.path ?? entry?.data?.input?.command ?? entry?.command ?? entry?.path;
  return typeof value === "string" ? value : "";
}

function normalizeOutcome(entry, type) {
  const decision = permissionDecisionRef(entry);
  const outcome = entry?.outcome ?? entry?.data?.outcome;
  return String(decision || outcome || type).toLowerCase();
}

function increment(map, key, amount = 1) {
  map.set(key, (map.get(key) ?? 0) + amount);
}

function sortedCounts(map) {
  return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([key, count]) => ({ key, count }));
}

function sessionKeyOf(project, session) {
  return `${project}\u0000${session}`;
}

/**
 * Records one observation for a candidate proposal together with the *distinct* project and
 * session that support it.
 *
 * The global multi-project guard is not enough: one busy project can carry an entire log past the
 * 2-project/5-session threshold while a specific proposal is still single-project folklore.
 * Pruning a shared rule on that evidence is exactly the catastrophic-forgetting failure mode
 * described in arXiv:2611.03219, so every proposal carries its own evidence set.
 *
 * A project only counts when the same record also carries a *real* attributed session. Otherwise a
 * session-less record (a bare `plugin.loaded`, a `shell.before` with no session) could supply the
 * second project that unlocks the per-proposal guard while contributing no history at all — the
 * guard would then be satisfied by one project's real usage plus another project's noise.
 */
function recordEvidence(map, key, { project, session, field = "observations" }) {
  let stat = map.get(key);
  if (!stat) {
    stat = { [field]: 0, projects: new Set(), sessions: new Set() };
    map.set(key, stat);
  }
  stat[field] += 1;
  if (isAttributedSession(session)) {
    stat.sessions.add(sessionKeyOf(project, session));
    if (isIdentifiedProject(project)) stat.projects.add(project);
  }
  return stat;
}

function evidenceOf(stat) {
  return { distinctProjects: stat.projects.size, sessions: stat.sessions.size };
}

/**
 * Gates one proposal on its own cross-project evidence. `force` keeps the historical override but
 * is recorded on the proposal so a forced global change is never silent.
 */
function gateProposal(evidence, { force }) {
  const suffices = evidence.distinctProjects >= MIN_DISTINCT_PROJECTS && evidence.sessions >= MIN_TOTAL_SESSIONS;
  return {
    allowed: force || suffices,
    forced: force && !suffices,
    distinctProjects: evidence.distinctProjects,
    sessions: evidence.sessions,
  };
}

function perProposalGuardReason(evidence) {
  return `this proposal is supported by ${evidence.distinctProjects} distinct project(s) and ${evidence.sessions} session(s); at least ${MIN_DISTINCT_PROJECTS} projects and ${MIN_TOTAL_SESSIONS} sessions are required for a global change (arXiv:2611.03219)`;
}

function scanTextForTerra(source, text) {
  const violations = [];
  const matches = String(text ?? "").match(TERRA_PATTERN) ?? [];
  for (const match of new Set(matches.map((value) => value.toLowerCase()))) {
    violations.push({ source, match });
  }
  return violations;
}

function candidateConfigPaths(options) {
  const explicit = options.configPaths ?? options.configPath ? [].concat(options.configPaths ?? options.configPath) : null;
  if (explicit) return explicit.map((path) => resolve(path));
  return [
    join(REPO_ROOT, "config", "opencode.jsonc"),
    join(homedir(), ".config", "opencode", "opencode.jsonc"),
  ];
}

function candidateAgentsPaths(options) {
  const explicit = options.agentsPaths ?? options.agentsPath ? [].concat(options.agentsPaths ?? options.agentsPath) : null;
  if (explicit) return explicit.map((path) => resolve(path));
  return [
    join(REPO_ROOT, "config", "AGENTS.md"),
    join(homedir(), ".config", "opencode", "AGENTS.md"),
  ];
}

function uniqueExisting(paths) {
  return [...new Set(paths.map((path) => resolve(path)))].filter((path) => existsSync(path));
}

function defaultSkillDirs(options) {
  const dirs = [
    join(REPO_ROOT, "skills"),
    join(REPO_ROOT, "config", "skills"),
    join(homedir(), ".config", "opencode", "skills"),
    join(homedir(), ".config", "opencode", "skill"),
  ];
  for (const dir of [].concat(options.skillsDirs ?? options.skillsDir ?? [])) dirs.push(resolve(dir));
  return [...new Set(dirs)];
}

/** Discovers skill names from conventional skill directories. */
export function discoverKnownSkills({ dirs = [] } = {}) {
  const names = new Set();
  for (const dir of uniqueExisting(dirs)) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (entry.isDirectory()) names.add(entry.name);
      else if (entry.isFile() && entry.name.endsWith(".md")) names.add(basename(entry.name, ".md"));
    }
  }
  return [...names].sort();
}

function analyzeEntries(entries, { dbMetrics = null } = {}) {
  const projects = new Map();
  const sessions = new Map();
  const models = new Map();
  const tools = new Map();
  const skills = new Map();
  const permissions = new Map();
  const permissionAsks = new Map();
  const seenPermissionAskIds = new Set();
  const shellFailures = new Map();
  const skillEvidence = { observations: 0, projects: new Set(), sessions: new Set() };
  let toolCalls = 0;
  let toolErrors = 0;
  let permissionBlocks = 0;
  let permissionAskCount = 0;
  let skillObservations = 0;

  // `tool.before` + `tool.after` describe one call; only the terminal record counts.
  const completedCalls = new Set();
  for (const entry of entries) {
    if (!isToolTerminalType(entryType(entry))) continue;
    const callId = toolCallId(entry);
    if (callId) completedCalls.add(callId);
  }

  const parentMap = dbMetrics?.sessionParentMap;
  const rootSessionOf = (sid) => {
    if (!parentMap || !sid) return sid;
    let cur = sid;
    const seen = new Set();
    while (parentMap.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      cur = parentMap.get(cur);
    }
    return cur;
  };

  for (const entry of entries) {
    const type = entryType(entry);
    const project = entryProject(entry);
    const session = entrySession(entry);
    const guardSession = isAttributedSession(session) ? rootSessionOf(session) : session;
    const error = entryError(entry, type);

    let projectStat = projects.get(project);
    if (!projectStat) projectStat = { project, sessions: new Set(), entries: 0, toolCalls: 0, errors: 0, costUSD: 0 };
    projectStat.entries += 1;
    if (isAttributedSession(guardSession)) projectStat.sessions.add(guardSession);
    projects.set(project, projectStat);

    const sessionKey = `${project}\u0000${session}`;
    let sessionStat = sessions.get(sessionKey);
    if (!sessionStat) sessionStat = { project, session, entries: 0, toolCalls: 0, errors: 0, cost: 0, models: new Set(), last: null };
    sessionStat.entries += 1;
    sessionStat.cost += entryCost(entry);
    const sessionModel = entryModel(entry);
    if (sessionModel) sessionStat.models.add(sessionModel);
    if (entryTimestamp(entry)) sessionStat.last = entryTimestamp(entry);
    sessions.set(sessionKey, sessionStat);

    const tool = entryTool(entry, type);
    const callId = toolCallId(entry);
    const supersededStart = Boolean(callId) && isToolStartType(type) && completedCalls.has(callId);
    if (tool && type.includes("tool") && !supersededStart) {
      toolCalls += 1;
      projectStat.toolCalls += 1;
      sessionStat.toolCalls += 1;
      increment(tools, tool);
      if (error) {
        toolErrors += 1;
        projectStat.errors += 1;
        sessionStat.errors += 1;
      }
    }

    const model = entryModel(entry);
    if (model) {
      let modelStat = models.get(model);
      if (!modelStat) modelStat = { model, turns: 0, costUSD: 0, errors: 0, projects: new Set(), sessions: new Set() };
      modelStat.turns += 1;
      modelStat.costUSD += entryCost(entry);
      if (error) modelStat.errors += 1;
      // Same rule as `recordEvidence()`: a project only counts when this very record also carries an
      // attributed session, so a session-less record cannot inflate a model's project evidence.
      if (isAttributedSession(guardSession)) {
        modelStat.sessions.add(sessionKeyOf(project, guardSession));
        if (isIdentifiedProject(project)) modelStat.projects.add(project);
      }
      models.set(model, modelStat);
    }

    const skill = entrySkill(entry);
    if (/skill/.test(type)) {
      skillObservations += 1;
      skillEvidence.observations += 1;
      if (isAttributedSession(guardSession)) {
        skillEvidence.sessions.add(sessionKeyOf(project, guardSession));
        if (isIdentifiedProject(project)) skillEvidence.projects.add(project);
      }
    }
    if (skill && /skill/.test(type)) increment(skills, skill);

    const permission = /permission/.test(type);
    const actionName = String(entry?.action ?? entry?.data?.action ?? "").trim().toLowerCase();
    const blocked = permission && /deny|denied|blocked|reject/.test(`${normalizeOutcome(entry, type)} ${type}`);
    if (blocked) {
      permissionBlocks += 1;
      const resources = entryResources(entry);
      if (resources.length === 0) recordEvidence(permissions, "unspecified", { project, session: guardSession, field: "blocks" });
      for (const resource of resources) recordEvidence(permissions, resource, { project, session: guardSession, field: "blocks" });
    }

    if (type === "permission.asked") {
      const permId = String(entry?.permissionID ?? entry?.id ?? entry?.data?.id ?? "");
      if (!permId || !seenPermissionAskIds.has(permId)) {
        if (permId) seenPermissionAskIds.add(permId);
        permissionAskCount += 1;
        const resources = entryResources(entry);
        const target = resources[0] ? String(resources[0]).trim().split(/\s+/u).slice(0, 3).join(" ") : (actionName || "unspecified");
        recordEvidence(permissionAsks, target, { project, session: guardSession, field: "asks" });
      }
    }

    const shellish = tool === "bash" || tool === "shell" || /shell/.test(type) ||
      (permission && SHELL_ACTIONS.has(actionName));
    if (shellish && (error || blocked)) {
      const command = entryResources(entry)[0] || entry?.input?.command || entry?.data?.input?.command || "shell";
      const prefix = String(command).trim().split(/\s+/u).slice(0, 3).join(" ") || "shell";
      recordEvidence(shellFailures, prefix, { project, session: guardSession, field: "failures" });
    }
  }

  // Merge authoritative session/project/model/cost stats from read-only `opencode.db`.
  // Guard integrity (B4):
  //   - Child subagent sessions (`parentId != null`) contribute their spend (we verified
  //     empirically that parent `session_v2.cost` excludes children) and model turns,
  //     but do NOT inflate independent session counts in `projectStat.sessions` or the
  //     catastrophic-forgetting guard!
  //   - Zero-activity DB-only sessions (no cost and no tokens) do not count as evidence.
  //   - Ephemeral `openchamber-chat` sessions are in `UNIDENTIFIED_PROJECTS` so ad-hoc
  //     chats never supply a second project to unlock global pruning.
  if (dbMetrics?.available) {
    for (const dbSession of dbMetrics.sessions ?? []) {
      const project = dbSession.project || "unknown";
      let projectStat = projects.get(project);
      if (!projectStat) projectStat = { project, sessions: new Set(), entries: 0, toolCalls: 0, errors: 0, costUSD: 0 };
      const totalTokens =
        (dbSession.tokens?.input ?? 0) +
        (dbSession.tokens?.output ?? 0) +
        (dbSession.tokens?.reasoning ?? 0) +
        (dbSession.tokens?.cacheRead ?? 0) +
        (dbSession.tokens?.cacheWrite ?? 0);
      const hasActivity = dbSession.costUSD > 0 || totalTokens > 0;
      const isRootSession = !dbSession.parentId;
      if (isRootSession && hasActivity) {
        projectStat.sessions.add(dbSession.id);
      }
      projectStat.costUSD += dbSession.costUSD;
      projects.set(project, projectStat);

      const sessionKey = `${project}\u0000${dbSession.id}`;
      let sessionStat = sessions.get(sessionKey);
      if (!sessionStat) {
        sessionStat = {
          project,
          session: dbSession.id,
          parentId: dbSession.parentId ?? null,
          entries: 0,
          toolCalls: 0,
          errors: 0,
          cost: dbSession.costUSD,
          models: new Set(dbSession.model ? [dbSession.model] : []),
          last: dbSession.timeUpdated ?? dbSession.timeCreated ?? null,
        };
        sessions.set(sessionKey, sessionStat);
      } else {
        if (Number.isFinite(dbSession.costUSD) && dbSession.costUSD > sessionStat.cost) {
          sessionStat.cost = dbSession.costUSD;
        }
        if (dbSession.model) sessionStat.models.add(dbSession.model);
        if (dbSession.timeUpdated && (!sessionStat.last || dbSession.timeUpdated > sessionStat.last)) {
          sessionStat.last = dbSession.timeUpdated;
        }
      }
    }

    // Authoritative per-model turn/cost/error metrics come from `session_message` in opencode.db
    // when available (audit logs omit model on sparse usage events). Strip `#variant` when
    // checking overlap so `provider/model#xhigh` in audit logs does not duplicate `provider/model`
    // already counted authoritatively from `opencode.db`.
    if (Array.isArray(dbMetrics.models) && dbMetrics.models.length > 0) {
      const stripVariant = (id) => String(id ?? "").replace(/#[^#]*$/u, "");
      const mergedModels = new Map();
      const dbBaseKeys = new Set();
      for (const m of dbMetrics.models) {
        const base = stripVariant(m.model);
        dbBaseKeys.add(base);
        mergedModels.set(m.model, {
          model: m.model,
          turns: m.turns,
          costUSD: m.costUSD,
          errors: m.errors,
          projects: new Set(m._projects ?? []),
          sessions: new Set(m._sessions ?? []),
        });
      }
      for (const [modelName, auditStat] of models.entries()) {
        if (!mergedModels.has(modelName) && !dbBaseKeys.has(stripVariant(modelName))) {
          mergedModels.set(modelName, auditStat);
        }
      }
      models.clear();
      for (const [k, v] of mergedModels.entries()) models.set(k, v);
    }
  } else {
    // Derive project cost from session sums when DB is not used.
    for (const s of sessions.values()) {
      const proj = projects.get(s.project);
      if (proj) proj.costUSD += s.cost;
    }
  }

  const totalCostUSD = dbMetrics?.available
    ? dbMetrics.totalCostUSD
    : Number([...sessions.values()].reduce((sum, s) => sum + s.cost, 0).toFixed(4));

  return {
    entries: entries.length,
    totalCostUSD,
    projects: [...projects.values()]
      .map((stat) => ({
        project: stat.project,
        sessions: stat.sessions.size,
        entries: stat.entries,
        toolCalls: stat.toolCalls,
        errors: stat.errors,
        costUSD: Number(stat.costUSD.toFixed(4)),
        errorRate: stat.toolCalls ? stat.errors / stat.toolCalls : 0,
      }))
      .sort((a, b) => b.costUSD - a.costUSD || b.entries - a.entries || a.project.localeCompare(b.project)),
    sessionCount: [...sessions.values()].filter((stat) => isAttributedSession(stat.session)).length,
    toolCalls,
    toolErrors,
    toolErrorRate: toolCalls ? toolErrors / toolCalls : 0,
    skillObservations,
    tools: sortedCounts(tools).map(({ key, count }) => ({ tool: key, calls: count })),
    models: [...models.values()]
      .map((stat) => ({
        model: stat.model,
        turns: stat.turns,
        costUSD: Number(stat.costUSD.toFixed(4)),
        avgCostPerTurnUSD: stat.turns ? Number((stat.costUSD / stat.turns).toFixed(4)) : 0,
        errors: stat.errors,
        errorRate: stat.turns ? stat.errors / stat.turns : 0,
        evidence: evidenceOf(stat),
      }))
      .sort((a, b) => b.costUSD - a.costUSD || b.turns - a.turns || a.model.localeCompare(b.model)),
    skillsUsed: sortedCounts(skills).map(({ key, count }) => ({ skill: key, activations: count })),
    skillEvidence: { observations: skillEvidence.observations, ...evidenceOf(skillEvidence) },
    permissionBlocks,
    permissionResources: [...permissions.entries()]
      .sort((a, b) => b[1].blocks - a[1].blocks || a[0].localeCompare(b[0]))
      .map(([resource, stat]) => ({ resource, blocks: stat.blocks, evidence: evidenceOf(stat) })),
    permissionAskCount,
    permissionAskResources: [...permissionAsks.entries()]
      .sort((a, b) => b[1].asks - a[1].asks || a[0].localeCompare(b[0]))
      .map(([resource, stat]) => ({ resource, asks: stat.asks, evidence: evidenceOf(stat) })),
    shellFailures: [...shellFailures.entries()]
      .sort((a, b) => b[1].failures - a[1].failures || a[0].localeCompare(b[0]))
      .map(([command, stat]) => ({ command, failures: stat.failures, evidence: evidenceOf(stat) })),
    sessions: [...sessions.values()]
      .filter((stat) => isAttributedSession(stat.session))
      .sort((a, b) => (b.last ?? 0) - (a.last ?? 0))
      .slice(0, 10)
      .map((stat) => ({ project: stat.project, session: stat.session, entries: stat.entries, toolCalls: stat.toolCalls, errors: stat.errors, costUSD: Number(stat.cost.toFixed(4)) })),
  };
}

function analyzeAgentsFiles(paths) {
  const files = paths.map((path) => {
    const text = readFileSync(path, "utf8");
    const chars = Array.from(text).length;
    return {
      path,
      chars,
      overTarget: chars > AGENTS_TARGET_CHARS,
      overHard: chars > AGENTS_HARD_CHARS,
    };
  });
  return { files, hardExceeded: files.some((file) => file.overHard), targetExceeded: files.some((file) => file.overTarget) };
}

function scanTerra(configPaths, agentsPaths, entries) {
  const violations = [];
  for (const path of configPaths) {
    try { violations.push(...scanTextForTerra(path, readFileSync(path, "utf8"))); } catch { /* unreadable files are reported elsewhere */ }
  }
  for (const path of agentsPaths) {
    try { violations.push(...scanTextForTerra(path, readFileSync(path, "utf8"))); } catch { /* ignored */ }
  }
  for (const entry of entries) {
    const model = entryModel(entry);
    if (model && /terra/i.test(model)) violations.push({ source: "audit", match: model });
  }
  const unique = [...new Map(violations.map((item) => [`${item.source}\u0000${item.match}`, item])).values()];
  return { ok: unique.length === 0, violations: unique };
}

/**
 * Builds pruning proposals, gating EACH one on its own cross-project evidence.
 *
 * Returns both the emitted proposals and the withheld ones (with their evidence) so the report
 * can explain why a candidate was not proposed instead of silently dropping it.
 */
function buildProposals({ analysis, skills, agents, permissions, shell, globalEvidence, force = false }) {
  const candidates = [];
  const add = (candidate) => candidates.push(candidate);

  const global = gateProposal(globalEvidence, { force });
  if (agents.hardExceeded) {
    add({
      kind: "agents-trim",
      target: "AGENTS.md",
      reason: `AGENTS.md exceeds the ${AGENTS_HARD_CHARS}-character hard ceiling; trim domain-specific rules into repository-local AGENTS.md files.`,
      evidence: { distinctProjects: global.distinctProjects, sessions: global.sessions },
    });
  } else if (agents.targetExceeded) {
    add({
      kind: "agents-trim",
      target: "AGENTS.md",
      reason: `AGENTS.md exceeds the ${AGENTS_TARGET_CHARS}-character target; consider consolidating repeated rules.`,
      evidence: { distinctProjects: global.distinctProjects, sessions: global.sessions },
    });
  }
  // Unobserved is not the same as unused: without any activation records in the window (the
  // Wave 2B plugin does not emit skill events yet), every known skill would look dead.
  if (skills.observed) {
    for (const skill of skills.unused) {
      add({
        kind: "dead-skill",
        target: skill,
        reason: "No skill activation was observed anywhere in the review window.",
        evidence: { distinctProjects: skills.evidence.distinctProjects, sessions: skills.evidence.sessions },
      });
    }
  }
  for (const model of analysis.models) {
    if (model.turns >= 3 && model.errorRate >= 0.34) {
      add({
        kind: "model-routing",
        target: model.model,
        reason: `${model.errors}/${model.turns} turns had errors (${(model.errorRate * 100).toFixed(0)}%); review whether this model is still the right route for the observed tasks.`,
        evidence: model.evidence,
      });
    }
  }
  for (const item of permissions.filter((resource) => resource.blocks >= 2)) {
    add({
      kind: "permission-rule",
      target: item.resource,
      reason: `${item.blocks} permission blocks observed; decide whether a narrower allow rule is safe or the guidance should change.`,
      evidence: item.evidence,
    });
  }
  for (const item of shell.filter((command) => command.failures >= 2)) {
    add({
      kind: "shell-guidance",
      target: item.command,
      reason: `${item.failures} shell failures/blocks for this command prefix; document the working invocation or narrow permissions.`,
      evidence: item.evidence,
    });
  }

  const proposals = [];
  const withheld = [];
  for (const candidate of candidates) {
    const gate = gateProposal(candidate.evidence, { force });
    const entry = { ...candidate, evidence: { ...candidate.evidence, forced: gate.forced } };
    if (gate.allowed) proposals.push(entry);
    else withheld.push({ ...entry, withheldReason: perProposalGuardReason(candidate.evidence) });
  }

  proposals.sort((a, b) => a.kind.localeCompare(b.kind) || a.target.localeCompare(b.target));
  withheld.sort((a, b) => a.kind.localeCompare(b.kind) || a.target.localeCompare(b.target));
  return { proposals, withheld };
}

function buildSynthesisPrompt(report) {
  return [
    {
      role: "system",
      content: "You are an independent RSI reviewer. Summarize evidence and recommend pruning or retention. Never claim a change was applied. Be concise and reference concrete counts.\n\nReturn plain text paragraphs, not JSON.",
    },
    {
      role: "user",
      content: JSON.stringify({
        days: report.days,
        guard: report.guard,
        projects: report.projects,
        toolStats: report.toolStats,
        models: report.models,
        skills: report.skills,
        agents: report.agents,
        permissions: report.permissions,
        shell: report.shell,
        terra: report.terra,
        proposals: report.pruning.proposals,
        withheldProposals: report.pruning.withheld,
        warnings: report.warnings,
      }, null, 2),
    },
  ];
}

function extractText(result) {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return "";
  if (typeof result.text === "string") return result.text;
  if (typeof result.content === "string") return result.content;
  if (typeof result.data?.text === "string") return result.data.text;
  return "";
}

async function synthesize(llm, report) {
  if (!llm) return { text: null, error: null };
  try {
    const request = { purpose: "rsi-synthesis", model: report.synthesisModel, messages: buildSynthesisPrompt(report), maxTokens: 500, temperature: 0.2 };
    let result;
    if (typeof llm === "function") result = await llm(request);
    else if (typeof llm.chat === "function") result = await llm.chat(request);
    else throw new Error("llm must be a function or expose chat()");
    const text = extractText(result).trim();
    if (!text) throw new Error("synthesis model returned empty text");
    return { text, error: null };
  } catch (error) {
    return { text: null, error: redactSecrets(error?.message ?? error, process.env.OPENROUTER_API_KEY) };
  }
}

/**
 * Runs the weekly RSI review. Pure analysis; it never writes AGENTS.md or opencode.jsonc.
 */
export async function runRsiPrune(options = {}) {
  const days = Number.isFinite(Number(options.days)) && Number(options.days) > 0 ? Number(options.days) : DEFAULT_RSI_DAYS;
  const now = options.now ?? Date.now();
  const auditDirs = options.auditDirs ?? (options.auditDir ? [options.auditDir] : []);
  // Auto-read authoritative opencode.db metrics unless explicitly disabled or running against
  // explicit isolated auditDirs without an explicit dbPath.
  const effectiveDbPath = options.dbPath !== undefined
    ? options.dbPath
    : (auditDirs.length > 0 ? false : undefined);
  const dbMetrics = await readOpenCodeDbMetrics({
    dbPath: effectiveDbPath,
    days,
    now,
  });
  const scan = readAuditEntries({
    dirs: auditDirs,
    days,
    now,
    maxEvents: options.maxEvents ?? null,
    sessionDirectoryMap: dbMetrics.available ? dbMetrics.sessionDirectoryMap : null,
    sessionModelMap: dbMetrics.available ? dbMetrics.sessionModelMap : null,
  });
  const analysis = analyzeEntries(scan.entries, { dbMetrics });

  const identifiedProjects = analysis.projects.filter((project) => isIdentifiedProject(project.project));
  const unidentifiedProjects = analysis.projects.filter((project) => !isIdentifiedProject(project.project));
  // A project is evidence only when it has at least one real session: a lone `plugin.loaded`
  // record from a one-shot CLI process (e.g. directory /root) is not a project with history.
  const projectsWithEvidence = identifiedProjects.filter((project) => project.sessions > 0);
  const distinctProjects = projectsWithEvidence.length;
  // Records that cannot be attributed to any project must not help satisfy a cross-project guard.
  const totalSessions = projectsWithEvidence.reduce((sum, project) => sum + project.sessions, 0);
  const unidentifiedSessions = unidentifiedProjects.reduce((sum, project) => sum + project.sessions, 0);
  const unidentifiedEntries = unidentifiedProjects.reduce((sum, project) => sum + project.entries, 0);
  const forced = Boolean(options.force);
  const allowed = forced || (distinctProjects >= MIN_DISTINCT_PROJECTS && totalSessions >= MIN_TOTAL_SESSIONS);
  const guardReason = allowed
    ? (forced && (distinctProjects < MIN_DISTINCT_PROJECTS || totalSessions < MIN_TOTAL_SESSIONS)
      ? `Forced with only ${distinctProjects} project(s) and ${totalSessions} session(s); the multi-project guard was overridden explicitly.`
      : `Cross-project evidence sufficient: ${distinctProjects} projects and ${totalSessions} sessions.`)
    : `Insufficient cross-project evidence: ${distinctProjects} distinct project(s) and ${totalSessions} session(s); at least ${MIN_DISTINCT_PROJECTS} projects and ${MIN_TOTAL_SESSIONS} sessions are required. Global pruning is REFUSED to avoid catastrophic forgetting (arXiv:2611.03219).`;

  const agentsPaths = uniqueExisting(candidateAgentsPaths(options));
  const configPaths = uniqueExisting(candidateConfigPaths(options));
  const agents = analyzeAgentsFiles(agentsPaths);
  const terra = scanTerra(configPaths, agentsPaths, scan.entries);
  const knownSkills = options.knownSkills
    ? [...new Set(options.knownSkills.map(String))].sort()
    : discoverKnownSkills({ dirs: defaultSkillDirs(options) });
  const usedSkills = new Set(analysis.skillsUsed.map((item) => item.skill));
  const unusedSkills = knownSkills.filter((skill) => !usedSkills.has(skill));

  const warnings = [];
  if (!allowed) warnings.push(`CATASTROPHIC-FORGETTING GUARD: ${guardReason}`);
  if (agents.hardExceeded) warnings.push(`AGENTS.md exceeds the ${AGENTS_HARD_CHARS}-character hard ceiling.`);
  else if (agents.targetExceeded) warnings.push(`AGENTS.md exceeds the ${AGENTS_TARGET_CHARS}-character target ceiling.`);
  if (!terra.ok) warnings.push(`GPT-6.1 Terra is banned but was found in ${terra.violations.length} place(s).`);
  if (analysis.permissionBlocks > 0) warnings.push(`${analysis.permissionBlocks} permission block(s) observed; repeated blocks indicate guidance/permission friction.`);
  if (analysis.toolErrors > 0) warnings.push(`${analysis.toolErrors} tool error(s) observed (${(analysis.toolErrorRate * 100).toFixed(1)}% of tool calls).`);
  if (knownSkills.length === 0) warnings.push("No known skill directories were found; dead-skill detection is limited to observed activations.");
  if (analysis.skillObservations === 0) warnings.push("No skill-activation records were found in the review window; skills are UNOBSERVED, not proven unused, so no dead-skill proposal is made.");
  if (unidentifiedEntries > 0) warnings.push(`${unidentifiedEntries} audit record(s) could not be attributed to a project; they are excluded from the ${MIN_DISTINCT_PROJECTS}-project/${MIN_TOTAL_SESSIONS}-session guard.`);

  const report = {
    generatedAt: new Date(now).toISOString(),
    days,
    auditFiles: scan.files,
    auditEntries: scan.entries.length,
    deduplicatedEvents: scan.deduplicatedEvents ?? 0,
    skippedAuditLines: scan.skippedLines,
    totalCostUSD: analysis.totalCostUSD,
    sources: {
      auditEntries: scan.entries.length,
      deduplicatedEvents: scan.deduplicatedEvents ?? 0,
      dbAvailable: dbMetrics.available,
      dbPath: dbMetrics.available ? dbMetrics.dbPath : null,
      dbSessions: dbMetrics.available ? dbMetrics.sessionCount : 0,
      dbError: dbMetrics.error ?? null,
    },
    guard: {
      allowed,
      forced,
      distinctProjects,
      totalSessions,
      unidentifiedEntries,
      unidentifiedSessions,
      requiredProjects: MIN_DISTINCT_PROJECTS,
      requiredSessions: MIN_TOTAL_SESSIONS,
      reason: guardReason,
    },
    projects: analysis.projects,
    totalSessions,
    toolStats: {
      calls: analysis.toolCalls,
      errors: analysis.toolErrors,
      errorRate: analysis.toolErrorRate,
      byTool: analysis.tools,
    },
    models: analysis.models,
    skills: {
      known: knownSkills,
      used: [...usedSkills].sort(),
      unused: unusedSkills,
      activations: analysis.skillsUsed,
      observations: analysis.skillObservations,
    },
    agents: {
      targetChars: AGENTS_TARGET_CHARS,
      hardChars: AGENTS_HARD_CHARS,
      files: agents.files,
      targetExceeded: agents.targetExceeded,
      hardExceeded: agents.hardExceeded,
    },
    permissions: {
      blocks: analysis.permissionBlocks,
      byResource: analysis.permissionResources,
      asks: analysis.permissionAskCount,
      askByResource: analysis.permissionAskResources,
    },
    shell: { failures: analysis.shellFailures },
    terra,
    recentSessions: analysis.sessions,
    warnings,
    pruning: { allowed, proposals: [], withheld: [] },
    synthesisModel: options.model ?? DEFAULT_SYNTHESIS_MODEL,
    synthesis: null,
    synthesisError: null,
  };

  if (allowed) {
    const built = buildProposals({
      analysis,
      skills: {
        unused: unusedSkills,
        observed: analysis.skillObservations > 0,
        evidence: analysis.skillEvidence ?? { distinctProjects: 0, sessions: 0 },
      },
      agents,
      globalEvidence: { distinctProjects, sessions: totalSessions },
      permissions: analysis.permissionResources,
      shell: analysis.shellFailures,
      force: forced,
    });
    report.pruning.proposals = built.proposals;
    report.pruning.withheld = built.withheld;
    for (const item of built.withheld) {
      warnings.push(`PER-PROPOSAL GUARD: withheld [${item.kind}] ${item.target} — ${item.withheldReason}.`);
    }
    if (built.proposals.some((proposal) => proposal.evidence?.forced)) {
      warnings.push("A proposal was emitted only because --force overrode its per-proposal evidence guard.");
    }
  }

  if (options.withLlm || options.llm) {
    const llm = options.llm ?? (process.env.OPENROUTER_API_KEY
      ? createOpenRouterClientFromEnv({ model: report.synthesisModel, fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs })
      : null);
    if (!llm) {
      report.synthesisError = "Synthesis requested but no llm or OPENROUTER_API_KEY was supplied";
    } else {
      const synthesis = await synthesize(llm, report);
      report.synthesis = synthesis.text;
      report.synthesisError = synthesis.error;
    }
  }

  return report;
}

/** Human-readable deterministic report. */
export function formatRsiReport(report) {
  const lines = [];
  lines.push(`RSI review — last ${report.days} day(s), generated ${report.generatedAt}`);
  lines.push(`Audit: ${report.auditEntries} entries from ${report.auditFiles.length} file(s), ${report.deduplicatedEvents ?? 0} duplicate event(s) collapsed, ${report.skippedAuditLines} malformed line(s) skipped.`);
  if (report.sources?.dbAvailable) {
    lines.push(`OpenCode DB (read-only): ${report.sources.dbSessions} session(s), $${Number(report.totalCostUSD ?? 0).toFixed(4)} total spend (${report.sources.dbPath}).`);
  }
  lines.push(`Projects: ${report.projects.map((project) => `${project.project} (${project.sessions} sessions, ${project.toolCalls} tool calls, ${project.errors} errors${project.costUSD ? `, $${project.costUSD}` : ""})`).join("; ") || "none"}`);
  lines.push(`Guard: ${report.guard.allowed ? "ALLOWED" : "REFUSED"} — ${report.guard.reason}`);
  lines.push(`Tools: ${report.toolStats.calls} calls, ${report.toolStats.errors} errors (${(report.toolStats.errorRate * 100).toFixed(1)}%).`);
  if (report.toolStats.byTool.length) lines.push(`Tool mix: ${report.toolStats.byTool.map((item) => `${item.tool}=${item.calls}`).join(", ")}`);
  if (report.models.length) {
    lines.push("Models:");
    for (const model of report.models) {
      lines.push(`- ${model.model}: ${model.turns} turns, $${model.costUSD} total, $${model.avgCostPerTurnUSD}/turn, ${(model.errorRate * 100).toFixed(1)}% errors`);
    }
  }
  lines.push(`Skills: known=${report.skills.known.length}, used=${report.skills.used.length}, unused=${report.skills.unused.length}${report.skills.observations === 0 ? " (unobserved — no dead-skill proposals)" : ""}${report.skills.unused.length && report.skills.observations > 0 ? ` (${report.skills.unused.join(", ")})` : ""}`);
  if (report.agents.files.length) {
    for (const file of report.agents.files) {
      lines.push(`AGENTS.md ${file.path}: ${file.chars} chars (target ${report.agents.targetChars}, hard ${report.agents.hardChars})${file.overHard ? " — HARD CEILING EXCEEDED" : file.overTarget ? " — target exceeded" : ""}`);
    }
  }
  lines.push(`Permission blocks: ${report.permissions.blocks}${report.permissions.byResource.length ? ` (${report.permissions.byResource.map((item) => `${item.resource}=${item.blocks}`).join(", ")})` : ""}`);
  if ((report.permissions.asks ?? 0) > 0) {
    lines.push(`Permission asks: ${report.permissions.asks}${report.permissions.askByResource?.length ? ` (${report.permissions.askByResource.slice(0, 8).map((item) => `${item.resource}=${item.asks}`).join(", ")})` : ""}`);
  }
  if (report.shell.failures.length) lines.push(`Shell friction: ${report.shell.failures.map((item) => `${item.command}=${item.failures}`).join(", ")}`);
  lines.push(`Terra ban: ${report.terra.ok ? "PASS" : `FAIL (${report.terra.violations.map((item) => `${item.source}:${item.match}`).join(", ")})`}`);
  if (report.warnings.length) {
    lines.push("Warnings:");
    for (const warning of report.warnings) lines.push(`- ${warning}`);
  }
  if (report.pruning.allowed) {
    lines.push("Pruning proposals (review only; nothing was applied):");
    if (report.pruning.proposals.length === 0) lines.push("- none");
    for (const proposal of report.pruning.proposals) {
      const evidence = proposal.evidence
        ? ` [evidence: ${proposal.evidence.distinctProjects} projects/${proposal.evidence.sessions} sessions${proposal.evidence.forced ? ", FORCED" : ""}]`
        : "";
      lines.push(`- [${proposal.kind}] ${proposal.target}: ${proposal.reason}${evidence}`);
    }
    const withheld = report.pruning.withheld ?? [];
    if (withheld.length > 0) {
      lines.push("Proposals withheld by the per-proposal forgetting guard:");
      for (const proposal of withheld) {
        lines.push(`- [${proposal.kind}] ${proposal.target}: ${proposal.withheldReason}`);
      }
    }
  } else {
    lines.push("Pruning proposals: withheld by the multi-project forgetting guard.");
  }
  if (report.synthesis) lines.push(`Synthesis: ${report.synthesis}`);
  if (report.synthesisError) lines.push(`Synthesis error: ${report.synthesisError}`);
  return lines.join("\n");
}

function parseCliArgs(argv) {
  const options = { auditDirs: [], agentsPaths: [], configPaths: [], skillsDirs: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${arg} requires a value`);
      return argv[i];
    };
    if (arg === "--days") options.days = Number(next());
    else if (arg === "--audit-dir") options.auditDirs.push(next());
    else if (arg === "--db") options.dbPath = next();
    else if (arg === "--no-db") options.dbPath = false;
    else if (arg === "--force") options.force = true;
    else if (arg === "--with-llm") options.withLlm = true;
    else if (arg === "--model") options.model = next();
    else if (arg === "--agents") options.agentsPaths.push(next());
    else if (arg === "--config") options.configPaths.push(next());
    else if (arg === "--skills-dir") options.skillsDirs.push(next());
    else if (arg === "--json") options.json = true;
    else if (arg === "--out") options.out = next();
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

/** Maximum number of symlink hops a single resolution may follow before it is refused. */
export const MAX_SYMLINK_HOPS = 40;

/**
 * Resolves `path` to a canonical absolute path, following symlinks in every segment — including
 * the final leaf — and re-appending segments that do not exist yet.
 *
 * `realpathSync` alone cannot do this: it throws on a *dangling* symlink, and the old fallback then
 * re-appended the leaf literally, so `safe/link -> /root/.pi/missing/report.txt` resolved to
 * `safe/link` and passed the protected-root check even though writing it would land in Pi's tree.
 * Walking segment by segment with `lstatSync`/`readlinkSync` resolves the link target itself (even
 * when the target does not exist yet), so the protected-path decision is made on the real
 * destination. Symlink loops are bounded by MAX_SYMLINK_HOPS.
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

/** Directories and files the RSI report must never be written into or over. */
export function protectedReportRoots({ repoRoot = REPO_ROOT } = {}) {
  return [
    resolve("/root/.pi"),
    resolve("/root/pi-projects/pi-workflow-tools"),
    join(homedir(), ".config", "opencode"),
    join(repoRoot, "config"),
  ];
}

/**
 * Canonicalizes an `--out` target and refuses protected trees.
 *
 * Symlinks are resolved segment by segment (including dangling links) before the check, so a link
 * planted inside a writable directory cannot smuggle the report into Pi's config,
 * pi-workflow-tools, the live OpenCode config, or this repository's own `config/` directory.
 */
export function resolveSafeReportPath(outPath, options = {}) {
  if (typeof outPath !== "string" || outPath.trim() === "") {
    throw new Error("--out requires a non-empty file path");
  }
  const canonical = realpathDeep(outPath);
  if (canonical === sep) throw new Error("Refusing to write the RSI report to the filesystem root");
  for (const root of protectedReportRoots(options)) {
    const resolvedRoot = realpathDeep(root);
    for (const forbidden of new Set([resolve(root), resolvedRoot])) {
      if (canonical === forbidden || canonical.startsWith(`${forbidden}${sep}`)) {
        throw new Error(`Refusing to write the RSI report into protected path: ${canonical}`);
      }
    }
  }
  return canonical;
}

/**
 * Writes the report to a validated path and returns the canonical file path actually written.
 *
 * The write itself is symlink-proof: `O_NOFOLLOW` makes the kernel refuse a leaf that is (or became)
 * a symlink between the canonicalization check and the open, and `0o600` keeps the report private.
 */
export function writeRsiReport(outPath, output, options = {}) {
  const target = resolveSafeReportPath(outPath, options);
  mkdirSync(dirname(target), { recursive: true });
  const body = `${String(output ?? "").replace(/\n+$/u, "")}\n`;
  const flags = fsConstants.O_CREAT | fsConstants.O_WRONLY | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW;
  const fd = openSync(target, flags, 0o600);
  try {
    writeSync(fd, body, null, "utf8");
  } finally {
    closeSync(fd);
  }
  return target;
}

function isMainModule() {
  const entry = process.argv[1];
  return Boolean(entry) && pathToFileURL(resolve(entry)).href === import.meta.url;
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node src/rsi-prune.mjs [--days 7] [--audit-dir DIR]... [--force] [--with-llm] [--json] [--out FILE]");
    return;
  }
  const report = await runRsiPrune(options);
  const output = options.json ? JSON.stringify(report, null, 2) : formatRsiReport(report);
  process.stdout.write(`${output}\n`);
  if (options.out) {
    const written = writeRsiReport(options.out, output);
    console.error(`RSI report written to ${written}`);
  }
}

if (isMainModule()) {
  main().catch((error) => {
    console.error(`rsi-prune: ${redactSecrets(error?.message ?? error, process.env.OPENROUTER_API_KEY)}`);
    process.exitCode = 1;
  });
}

export const RSI_INTERNALS = Object.freeze({
  analyzeEntries,
  analyzeAgentsFiles,
  scanTerra,
  buildProposals,
  realpathDeep,
  recordEvidence,
});
