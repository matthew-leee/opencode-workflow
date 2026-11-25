// Setup verification for the OpenCode v2 global config. It parses JSONC strictly, asserts the
// invariants this repository cares about (no Terra, pi_search + codemode, all eight agents,
// permission ordering), checks the AGENTS.md size ceiling, runs the real binary in an isolated
// XDG environment, and fails if the audit plugin logged a load error OR could not prove it loaded
// by writing a fresh `plugin.loaded` record into that run's isolated audit directory. Nothing here
// mutates the live config; --schema is the only optional network call.

import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, copyFileSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const REQUIRED_AGENTS = Object.freeze([
  "build",
  "plan",
  "worker",
  "reviewer",
  "fact-checker",
  "escalate-opus",
  "escalate-fable",
  "alt-reviewer",
]);
export const TERRA_FRAGMENT = "gpt-6.1-terra";
export const AGENTS_TARGET_CHARS = 2800;
export const AGENTS_HARD_CHARS = 3000;
export const DEFAULT_OPENCODE_BIN = "/root/.opencode/bin/opencode";
export const DEFAULT_SCHEMA_URL = "https://opencode.ai/config.json";
/** Day files larger than this are not scanned for audit evidence (bounded read). */
export const MAX_AUDIT_EVIDENCE_BYTES = 32 * 1024 * 1024;

// --- OCW-02/03/04 strict bounds -------------------------------------------------------------
/** A subagent that can loop longer than this is effectively unbounded *and* unbudgeted. */
export const MAX_SUBAGENT_STEPS = 100;
/**
 * Subagents whose `steps` may be omitted: `reactive-guard.js` bounds spin dynamically (detects
 * repeated failures and stalls at runtime), so a static step cap is not the control for `worker`.
 * If `steps` is present anyway, it is still validated against MAX_SUBAGENT_STEPS.
 */
export const OPTIONAL_STEPS_SUBAGENTS = Object.freeze(["worker"]);
/** Compaction must keep a bounded tail, or context cost grows without limit. */
export const MAX_COMPACTION_KEEP_TOKENS = 200_000;
export const MAX_TOOL_OUTPUT_LINES = 4_000;
export const MAX_TOOL_OUTPUT_BYTES = 1_048_576;
export const MAX_MEDIA_IMAGE_DIMENSION = 4_096;
export const MAX_MEDIA_IMAGE_BASE64_BYTES = 8 * 1024 * 1024;
/** Agents whose role is read-only: they must deny every write-capable action. */
export const READ_ONLY_AGENTS = Object.freeze(["reviewer", "fact-checker", "alt-reviewer", "plan"]);
export const PRIMARY_AGENTS = Object.freeze(["build", "plan"]);
export const WRITE_ACTIONS = Object.freeze(["edit", "write", "patch"]);
/** Every action name that can read or mutate a `.env` file must resolve to ask/deny. */
export const ENV_PROTECTED_ACTIONS = Object.freeze(["read", "edit", "write", "patch", "shell", "bash"]);
/** Representative `.env` names the ruleset must protect (`*.env` and `*.env.*`-style patterns). */
export const ENV_PROTECTED_RESOURCES = Object.freeze([".env", "production.env"]);
export const ENV_SAMPLE_RESOURCE = ".env.example";
/** Path used to prove a read-only agent's wildcard denial actually wins. */
export const REPRESENTATIVE_WRITE_PATH = "src/app.mjs";
/** Pinned model ids must resolve as `provider/model` (optionally `#variant`), per the live schema. */
export const MODEL_ID_PATTERN = /^[^/#]+\/[^#]+(?:#[^#]+)?$/u;
/** File-path tools whose resource is a single path (a `*.env.example` allow is safe for these). */
export const FILE_ACTIONS = Object.freeze(["read", "edit", "write", "patch"]);
/** Actions whose resource is a whole command line (a trailing glob allow would be a bypass). */
export const SHELL_ACTIONS = Object.freeze(["shell", "bash"]);
/**
 * Commands that read a real `.env` and then merely *end* with `.env.example`. A trailing
 * `*.env.example` allow rule would match them and let the `.env` read through, so both must
 * resolve to ask/deny on `shell` and `bash`.
 */
export const ENV_SAMPLE_BYPASS_COMMANDS = Object.freeze(["cat .env # .env.example", "cat .env; cat .env.example"]);
/** The audit plugin's own id, as stamped on every `plugin.loaded` record. */
export const AUDIT_PLUGIN_ID = "opencode-workflow-audit";
/**
 * OCW-03 approved model catalog — the only model ids this workflow may pin.
 *
 * A shape-only `provider/model` regex accepts any string that looks like an id (for example
 * `not-a-catalog/model`), which pins an agent to a model that may not exist, may be banned, or may
 * not be in the approved/budgeted lineup. `#variant` suffixes and the `openrouter/` routing prefix
 * are normalized away before comparison, so `openrouter/google/gemini-4-neon#high` is approved
 * while `not-a-catalog/model` is not.
 */
export const APPROVED_MODELS = Object.freeze([
  "openrouter/google/gemini-4-neon",
  "openrouter/deepseek/deepseek-v4.1-flash-1017",
  "openrouter/anthropic/claude-sonnet-5.5",
  "openrouter/anthropic/claude-opus-5.5",
  "openrouter/anthropic/claude-fable-5.2",
  "openrouter/openai/gpt-6.2-sol",
  "openrouter/openai/gpt-6-luna",
]);

/** Canonical form used for catalog comparison: no `#variant`, no `openrouter/` routing prefix. */
export function normalizeModelId(model) {
  return String(model ?? "").trim().replace(/#[^#]*$/u, "").replace(/^openrouter\//u, "");
}

const APPROVED_MODEL_IDS = new Set(APPROVED_MODELS.map(normalizeModelId));

/** True only for a model id in the approved OCW-03 catalog. */
export function isApprovedModel(model) {
  return APPROVED_MODEL_IDS.has(normalizeModelId(model));
}

/** Removes // and block comments and trailing commas without touching string contents. */
export function stripJsonc(text) {
  const source = String(text ?? "");
  let withoutComments = "";
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];
    if (lineComment) {
      if (char === "\n") { lineComment = false; withoutComments += char; }
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") { blockComment = false; i += 1; }
      continue;
    }
    if (inString) {
      withoutComments += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; withoutComments += char; continue; }
    if (char === "/" && next === "/") { lineComment = true; i += 1; continue; }
    if (char === "/" && next === "*") { blockComment = true; i += 1; continue; }
    withoutComments += char;
  }

  // Second pass: remove commas directly before } or ], string-aware.
  let out = "";
  inString = false;
  escaped = false;
  for (let i = 0; i < withoutComments.length; i += 1) {
    const char = withoutComments[i];
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; out += char; continue; }
    if (char === ",") {
      let j = i + 1;
      while (j < withoutComments.length && /\s/.test(withoutComments[j])) j += 1;
      if (withoutComments[j] === "}" || withoutComments[j] === "]") continue;
    }
    out += char;
  }
  return out;
}

/**
 * Asserts a limit is present, finite and inside its bounded maximum.
 * `0`/NaN/Infinity/huge values are failures: each one silently disables the limit it describes.
 */
function assertBounded(errors, label, value, { min = 1, max, integer = true } = {}) {
  if (value === undefined || value === null) {
    errors.push(`${label} is missing`);
    return;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < min) {
    errors.push(`${label} must be a finite number >= ${min} (found ${JSON.stringify(value)})`);
    return;
  }
  if (integer && !Number.isInteger(numeric)) {
    errors.push(`${label} must be an integer (found ${JSON.stringify(value)})`);
    return;
  }
  if (Number.isFinite(max) && numeric > max) {
    errors.push(`${label} exceeds the bounded maximum ${max} (found ${numeric})`);
  }
}

export class JsoncError extends Error {
  constructor(message) {
    super(message);
    this.name = "JsoncError";
  }
}

export function parseJsonc(text) {
  try {
    return JSON.parse(stripJsonc(text));
  } catch (error) {
    throw new JsoncError(`Invalid JSONC: ${error?.message ?? error}`);
  }
}

function globToRegExp(pattern) {
  const escaped = String(pattern)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "u");
}

function lastMatchingRule(permissions, action, resource) {
  let match = null;
  for (const rule of permissions) {
    if (!rule || typeof rule.action !== "string" || typeof rule.resource !== "string") continue;
    const actionMatches = rule.action === "*" || globToRegExp(rule.action).test(action);
    const resourceMatches = globToRegExp(rule.resource).test(resource);
    if (actionMatches && resourceMatches) match = rule;
  }
  return match;
}

function collectTerra(value, path = "config") {
  const violations = [];
  if (typeof value === "string") {
    if (value.toLowerCase().includes(TERRA_FRAGMENT)) violations.push({ path, value });
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => violations.push(...collectTerra(item, `${path}[${index}]`)));
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (key.toLowerCase().includes("terra")) violations.push({ path: `${path}.${key}`, value: key });
      violations.push(...collectTerra(item, `${path}.${key}`));
    }
  }
  return violations;
}

/** Strict config invariants used by `npm run verify`. */
export function validateConfig(config) {
  const errors = [];
  const warnings = [];
  const checks = [];
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return { ok: false, errors: ["Config root must be a JSON object"], warnings, checks };
  }

  const terra = collectTerra(config);
  if (terra.length) {
    errors.push(`Banned GPT-6.1 Terra reference(s): ${terra.map((item) => item.path).join(", ")}`);
  } else {
    checks.push("Terra ban: pass");
  }

  if (config.$schema !== DEFAULT_SCHEMA_URL) warnings.push(`$schema is not ${DEFAULT_SCHEMA_URL}`);

  const servers = config.mcp?.servers ?? config.mcp;
  const piSearch = servers?.pi_search;
  if (!piSearch || typeof piSearch !== "object") {
    errors.push("mcp.servers.pi_search is missing");
  } else {
    if (piSearch.type !== "local") errors.push("mcp.servers.pi_search.type must be \"local\"");
    if (!Array.isArray(piSearch.command) || piSearch.command.length === 0) {
      errors.push("mcp.servers.pi_search.command must be a non-empty array (OpenCode 2.3.2 has no args field)");
    }
    if (piSearch.codemode !== true) errors.push("mcp.servers.pi_search.codemode must be true");
    if (!errors.some((error) => error.includes("pi_search"))) checks.push("pi_search MCP: pass (local, codemode)");
  }

  const agents = config.agents && typeof config.agents === "object" ? config.agents : {};
  const missingAgents = REQUIRED_AGENTS.filter((name) => !agents[name] || typeof agents[name] !== "object");
  if (missingAgents.length) errors.push(`Missing required agent(s): ${missingAgents.join(", ")}`);
  else checks.push(`Agent roster: pass (${REQUIRED_AGENTS.length}/8)`);
  for (const [name, agent] of Object.entries(agents)) {
    if (agent && typeof agent.model === "string" && agent.model.toLowerCase().includes(TERRA_FRAGMENT)) {
      errors.push(`Agent ${name} uses banned Terra model ${agent.model}`);
    }
  }

  // --- OCW-03: every roster agent must pin a catalog-resolvable model id -------------
  const modelErrorsBefore = errors.length;
  for (const name of REQUIRED_AGENTS) {
    const agent = agents[name];
    if (!agent || typeof agent !== "object") continue;
    const model = agent.model;
    if (typeof model !== "string" || model.trim() === "") {
      errors.push(`Agent ${name} has no pinned model id (expected provider/model)`);
    } else if (!MODEL_ID_PATTERN.test(model)) {
      errors.push(`Agent ${name} model "${model}" is not a pinned provider/model id`);
    } else if (!isApprovedModel(model)) {
      errors.push(`Agent ${name} model "${model}" is not in the approved OCW-03 model catalog (${APPROVED_MODELS.join(", ")})`);
    }
  }
  // Non-roster agents (built-in overrides or later additions) must not pin an unapproved model
  // either: the allowlist applies to every agent in the config, not just the eight required ones.
  for (const [name, agent] of Object.entries(agents)) {
    if (REQUIRED_AGENTS.includes(name)) continue;
    const model = agent?.model;
    if (typeof model !== "string" || model.trim() === "") continue;
    if (!MODEL_ID_PATTERN.test(model)) {
      errors.push(`Agent ${name} model "${model}" is not a pinned provider/model id`);
    } else if (!isApprovedModel(model)) {
      errors.push(`Agent ${name} model "${model}" is not in the approved OCW-03 model catalog (${APPROVED_MODELS.join(", ")})`);
    }
  }
  // The top-level default model drives every agent that does not pin its own id, so it is held to
  // the same catalog.
  if (typeof config.model === "string" && config.model.trim() !== "" && !isApprovedModel(config.model)) {
    errors.push(`Config model "${config.model}" is not in the approved OCW-03 model catalog (${APPROVED_MODELS.join(", ")})`);
  }
  if (errors.length === modelErrorsBefore) checks.push(`Pinned models: pass (${REQUIRED_AGENTS.length} agents, OCW-03 catalog)`);

  // --- OCW-04: mode, bounded steps, and read-only roles ------------------------------
  const modeErrorsBefore = errors.length;
  for (const name of PRIMARY_AGENTS) {
    const agent = agents[name];
    if (!agent || typeof agent !== "object") continue;
    if (agent.mode !== "primary") errors.push(`Agent ${name} must be mode "primary" (found ${JSON.stringify(agent.mode)})`);
  }
  for (const name of REQUIRED_AGENTS.filter((item) => !PRIMARY_AGENTS.includes(item))) {
    const agent = agents[name];
    if (!agent || typeof agent !== "object") continue;
    if (agent.mode !== "subagent") errors.push(`Agent ${name} must be mode "subagent" (found ${JSON.stringify(agent.mode)})`);
    if (OPTIONAL_STEPS_SUBAGENTS.includes(name) && agent.steps === undefined) {
      // Omitted steps are valid only for the dynamically guarded agents; an explicit value is
      // still bounded below.
    } else {
      assertBounded(errors, `Agent ${name} steps`, agent.steps, { max: MAX_SUBAGENT_STEPS });
    }
  }
  if (errors.length === modeErrorsBefore) {
    checks.push(
      `Agent modes and step limits: pass (subagent steps <= ${MAX_SUBAGENT_STEPS}; optional on ${OPTIONAL_STEPS_SUBAGENTS.join(", ")}: reactive-guard bounds spin)`,
    );
  }

  const readOnlyErrorsBefore = errors.length;
  for (const name of READ_ONLY_AGENTS) {
    const agent = agents[name];
    if (!agent || typeof agent !== "object") continue;
    const rules = Array.isArray(agent.permissions) ? agent.permissions : null;
    if (!rules) {
      errors.push(`Agent ${name} is read-only but declares no permissions that deny writes`);
      continue;
    }
    for (const action of WRITE_ACTIONS) {
      const rule = lastMatchingRule(rules, action, REPRESENTATIVE_WRITE_PATH);
      const effect = rule?.effect ?? "no rule";
      if (effect !== "deny") {
        errors.push(`Agent ${name} is read-only but ${action} ${REPRESENTATIVE_WRITE_PATH} resolves to ${effect} (expected deny)`);
      }
    }
  }
  if (errors.length === readOnlyErrorsBefore) {
    checks.push(`Read-only agents: pass (${READ_ONLY_AGENTS.join(", ")} deny ${WRITE_ACTIONS.join("/")})`);
  }

  // --- OCW-02: compaction, tool-output and media limits must exist and be bounded ----
  const limitErrorsBefore = errors.length;
  const compaction = config.compaction;
  if (!compaction || typeof compaction !== "object" || Array.isArray(compaction)) {
    errors.push("compaction limits are missing (compaction.keep.tokens must be bounded)");
  } else {
    const keep = compaction.keep;
    if (!keep || typeof keep !== "object" || Array.isArray(keep)) errors.push("compaction.keep is missing");
    else assertBounded(errors, "compaction.keep.tokens", keep.tokens, { max: MAX_COMPACTION_KEEP_TOKENS });
    if (compaction.auto !== undefined && typeof compaction.auto !== "boolean") errors.push("compaction.auto must be a boolean");
    if (compaction.buffer !== undefined && !(typeof compaction.buffer === "string" && /^\d+%$/u.test(compaction.buffer))) {
      errors.push(`compaction.buffer must be a percentage string such as "20%" (found ${JSON.stringify(compaction.buffer)})`);
    }
  }
  const toolOutput = config.tool_output;
  if (!toolOutput || typeof toolOutput !== "object" || Array.isArray(toolOutput)) {
    errors.push("tool_output limits are missing (max_lines and max_bytes must be bounded)");
  } else {
    assertBounded(errors, "tool_output.max_lines", toolOutput.max_lines, { max: MAX_TOOL_OUTPUT_LINES });
    assertBounded(errors, "tool_output.max_bytes", toolOutput.max_bytes, { max: MAX_TOOL_OUTPUT_BYTES });
  }
  const mediaImage = config.media && typeof config.media === "object" ? config.media.image : null;
  if (!mediaImage || typeof mediaImage !== "object" || Array.isArray(mediaImage)) {
    errors.push("media.image limits are missing (max_width/max_height/max_base64_bytes must be bounded)");
  } else {
    assertBounded(errors, "media.image.max_width", mediaImage.max_width, { max: MAX_MEDIA_IMAGE_DIMENSION });
    assertBounded(errors, "media.image.max_height", mediaImage.max_height, { max: MAX_MEDIA_IMAGE_DIMENSION });
    assertBounded(errors, "media.image.max_base64_bytes", mediaImage.max_base64_bytes, { max: MAX_MEDIA_IMAGE_BASE64_BYTES });
  }
  if (errors.length === limitErrorsBefore) checks.push("Bounded context/media limits: pass (compaction, tool_output, media.image)");

  const permissions = config.permissions;
  if (!Array.isArray(permissions) || permissions.length === 0) {
    errors.push("permissions must be a non-empty ordered array");
  } else {
    const invalid = permissions
      .map((rule, index) => ({ rule, index }))
      .filter(({ rule }) => !rule || typeof rule.action !== "string" || typeof rule.resource !== "string" || !["allow", "deny", "ask"].includes(rule.effect));
    if (invalid.length) errors.push(`Invalid permission rule(s) at index(es): ${invalid.map((item) => item.index).join(", ")}`);

    const broadAllowIndex = permissions.findIndex((rule) => rule?.action === "*" && rule?.resource === "*" && rule?.effect === "allow");
    if (broadAllowIndex === -1) {
      errors.push("permissions must include a baseline {action:\"*\",resource:\"*\",effect:\"allow\"} rule");
    } else if (broadAllowIndex !== 0) {
      errors.push("the baseline allow rule must be first so later restrictive rules win");
    }

    const sensitive = [
      { action: "read", resource: ".env" },
      { action: "read", resource: "production.env" },
      { action: "read", resource: "id_rsa" },
      { action: "read", resource: "server.pem" },
      { action: "read", resource: "/app/secrets/key" },
    ];
    for (const item of sensitive) {
      const rule = lastMatchingRule(permissions, item.action, item.resource);
      if (!rule || !["ask", "deny"].includes(rule.effect)) {
        errors.push(`permission ordering: ${item.action} ${item.resource} resolves to ${rule?.effect ?? "no rule"} (expected ask/deny)`);
      }
    }
    // The documentation sample stays usable on every file-path tool.
    for (const action of FILE_ACTIONS) {
      const exampleRule = lastMatchingRule(permissions, action, ENV_SAMPLE_RESOURCE);
      if (!exampleRule || exampleRule.effect !== "allow") {
        errors.push(`permission ordering: ${action} ${ENV_SAMPLE_RESOURCE} must be explicitly allowed (found ${exampleRule?.effect ?? "no rule"})`);
      }
    }
    // …but never on a shell action, whose resource is the whole command line: a trailing
    // `*.env.example` allow would let `cat .env # .env.example` read the real `.env`.
    for (const action of SHELL_ACTIONS) {
      for (const command of ENV_SAMPLE_BYPASS_COMMANDS) {
        const rule = lastMatchingRule(permissions, action, command);
        if (!rule || !["ask", "deny"].includes(rule.effect)) {
          errors.push(
            `permission ordering: ${action} "${command}" resolves to ${rule?.effect ?? "no rule"} (expected ask/deny — no *.env.example allow may cover a ${action} command line)`,
          );
        }
      }
    }

    // --- OCW-02: `.env` must never fall through to the baseline allow rule -----------
    const unprotectedActions = ENV_PROTECTED_ACTIONS.filter((action) =>
      !ENV_PROTECTED_RESOURCES.every((resource) => ["ask", "deny"].includes(lastMatchingRule(permissions, action, resource)?.effect)),
    );
    if (unprotectedActions.length > 0) {
      errors.push(`.env protection is incomplete for action(s): ${unprotectedActions.join(", ")} — every ${ENV_PROTECTED_ACTIONS.join("/")} rule must resolve .env to ask/deny (only ${ENV_SAMPLE_RESOURCE} stays allowed)`);
    } else {
      checks.push(`.env protection: pass (${ENV_PROTECTED_ACTIONS.join(", ")})`);
    }

    if (!errors.some((error) => error.startsWith("permission ordering")) && broadAllowIndex === 0) {
      checks.push("Permission ordering: pass (baseline first, secrets protected after)");
    }
  }

  return { ok: errors.length === 0, errors, warnings, checks, terra };
}

/** Checks the AGENTS.md character ceiling (2,800 target, 3,000 hard). */
export function validateAgentsFile(agentsPath = join(REPO_ROOT, "config", "AGENTS.md")) {
  const path = resolve(agentsPath);
  if (!existsSync(path)) {
    return { ok: false, path, chars: 0, errors: [`AGENTS.md not found: ${path}`], warnings: [] };
  }
  const chars = Array.from(readFileSync(path, "utf8")).length;
  const errors = chars > AGENTS_HARD_CHARS ? [`AGENTS.md is ${chars} chars, above the ${AGENTS_HARD_CHARS}-char hard ceiling`] : [];
  const warnings = chars > AGENTS_TARGET_CHARS && chars <= AGENTS_HARD_CHARS
    ? [`AGENTS.md is ${chars} chars, above the ${AGENTS_TARGET_CHARS}-char target`]
    : [];
  return { ok: errors.length === 0, path, chars, targetChars: AGENTS_TARGET_CHARS, hardChars: AGENTS_HARD_CHARS, errors, warnings };
}

/** Counts failed-to-load-plugin log lines that concern this workflow's audit plugin. */
export function inspectPluginLoadLog(text, { pluginMarkers = ["opencode-workflow-audit", "audit-logger"] } = {}) {
  const failures = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (!/failed to load plugin/i.test(line)) continue;
    const lowered = line.toLowerCase();
    if (pluginMarkers.some((marker) => lowered.includes(marker.toLowerCase()))) failures.push(line.trim());
  }
  return { ok: failures.length === 0, failures, count: failures.length };
}

/**
 * The audit directory the plugin writes to, resolved exactly as plugins/audit-logger resolves it:
 * `OPENCODE_WORKFLOW_AUDIT_DIR` when set, otherwise `<data home>/opencode-workflow/audit`.
 */
export function resolveAuditDir(env = process.env) {
  const configured = env?.OPENCODE_WORKFLOW_AUDIT_DIR;
  if (typeof configured === "string" && configured.trim().length > 0) return resolve(configured.trim());
  const dataHome = env?.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(dataHome, "opencode-workflow", "audit");
}

/**
 * Proves the audit plugin actually loaded and wrote JSONL on this machine: the newest day files
 * are scanned (bounded) for `plugin.loaded`, and a runtime-disabled logger is a hard failure.
 *
 * A record only counts as evidence when it names this plugin (`plugin === 'opencode-workflow-audit'`)
 * *and* proves the logger was enabled at load time (`loggingEnabled === true`). A bare
 * `{"event":"plugin.loaded"}` (or a foreign plugin id, or a missing/unknown logging flag) proves
 * nothing about this workflow's plugin and is rejected.
 */
export function inspectAuditEvidence(dir) {
  const result = {
    ok: false,
    dir,
    files: [],
    pluginLoaded: 0,
    loggingDisabled: [],
    rejectedLoads: [],
    records: 0,
    errors: [],
    warnings: [],
  };
  if (!dir || !existsSync(dir)) {
    result.warnings.push(`No audit directory at ${dir}; the audit plugin has not written any JSONL yet`);
    return result;
  }
  let names;
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".jsonl")).sort().slice(-3);
  } catch (error) {
    result.errors.push(`Audit directory unreadable: ${error?.message ?? error}`);
    return result;
  }
  result.files = names.map((name) => join(dir, name));
  for (const file of result.files) {
    let text;
    try {
      if (statSync(file).size > MAX_AUDIT_EVIDENCE_BYTES) continue;
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      result.records += 1;
      if (record?.event !== "plugin.loaded") continue;
      if (record.plugin !== AUDIT_PLUGIN_ID) {
        result.rejectedLoads.push({
          file,
          reason: `plugin id ${JSON.stringify(record.plugin ?? null)} is not ${AUDIT_PLUGIN_ID}`,
        });
        continue;
      }
      if (record.loggingEnabled !== true) {
        result.rejectedLoads.push({
          file,
          reason: `loggingEnabled is ${JSON.stringify(record.loggingEnabled ?? null)}, not true`,
        });
        if (record.loggingEnabled === false) {
          result.loggingDisabled.push({ file, reason: record.loggingDisabledReason ?? "unknown" });
        }
        continue;
      }
      result.pluginLoaded += 1;
    }
  }
  for (const item of result.rejectedLoads) {
    result.errors.push(`Unproven plugin.loaded record in ${item.file}: ${item.reason}`);
  }
  for (const item of result.loggingDisabled) {
    result.errors.push(`Audit logging was disabled at runtime (${item.reason}) in ${item.file}`);
  }
  result.ok = result.pluginLoaded > 0 && result.errors.length === 0;
  if (result.pluginLoaded === 0) {
    result.warnings.push(
      `No verifiable plugin.loaded record (plugin=${AUDIT_PLUGIN_ID}, loggingEnabled=true) in ${result.files.length} audit file(s) under ${dir}`,
    );
  }
  return result;
}

/** True for a `{...}` value (not `null`, not an array). */
function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Unwraps the two shapes `opencode --standalone debug config` has printed in practice.
 *
 * OpenCode 2.3.2 prints an **array of layered entries**, not one object:
 *
 *   [
 *     { type: "document", path: "/root/.config/opencode/opencode.jsonc", info: { model: {...}, ... } },
 *     { type: "directory", path: "/root/.config/opencode", info: {} },
 *     { type: "directory", path: "/root/.opencode", info: {} },
 *   ]
 *
 * Only the `document` entries carry resolved config, so their `info` objects are merged in output
 * order with later documents winning per top-level key — the same precedence the loader applies.
 * Non-document entries are never merged, even when they carry a non-empty `info`: a `directory`
 * entry (or any other type) is metadata, not config, and merging it would let a directory-shaped
 * blob pose as a resolved config. An array that yields no keys (`[]`, only directory entries, or
 * only non-document entries carrying info) resolves nothing and is rejected rather than silently
 * treated as an empty-but-valid config. A plain object (pre-2.3.2 / handcrafted shape) is returned
 * unchanged.
 */
export function unwrapResolvedConfig(config) {
  if (isPlainObject(config)) return { ok: true, config };
  if (!Array.isArray(config)) return { ok: false, errors: ["debug config did not resolve to a JSON object"] };

  const carriesInfo = (entry) => isPlainObject(entry) && isPlainObject(entry.info) && Object.keys(entry.info).length > 0;
  const sources = config.filter((entry) => carriesInfo(entry) && entry.type === "document");
  const merged = {};
  for (const entry of sources) {
    for (const [key, value] of Object.entries(entry.info)) merged[key] = value;
  }
  if (!Object.keys(merged).length) {
    return {
      ok: false,
      errors: [
        `debug config did not resolve to a JSON object (${config.length} entry/entries, no document entry carrying config info)`,
      ],
    };
  }
  return { ok: true, config: merged };
}

/**
 * Normalizes a resolved `model` value to a `provider/model#variant` id.
 *
 * 2.3.2 resolves the default model to an object (`{ providerID: "openrouter", model:
 * "google/gemini-4-neon", variant: "high" }`) while the source config spells it as one string.
 * Both are handled, and both are then held to the same OCW-03 catalog check.
 */
export function resolvedModelId(model) {
  if (typeof model === "string") return model.trim() || null;
  if (!isPlainObject(model)) return null;
  const providerID = typeof model.providerID === "string" ? model.providerID.trim() : "";
  const id = typeof model.model === "string" ? model.model.trim() : "";
  if (!providerID || !id) return null;
  const variant = typeof model.variant === "string" ? model.variant.trim() : "";
  return variant ? `${providerID}/${id}#${variant}` : `${providerID}/${id}`;
}

/**
 * Validates the *resolved* config printed by `opencode --standalone debug config`.
 *
 * Parsing alone is not verification: `{}` (and `[]`, and a document-less entry list) is valid JSON
 * and would sail through, even though it proves the binary resolved no model, no pi_search MCP
 * server and no audit plugin. Each of those is required for the workflow to work at all.
 */
export function validateResolvedConfig(config) {
  const unwrapped = unwrapResolvedConfig(config);
  if (!unwrapped.ok) return { ok: false, errors: unwrapped.errors };
  const resolved = unwrapped.config;

  const errors = [];
  const modelId = resolvedModelId(resolved.model);
  if (!modelId) {
    errors.push("debug config resolved no model");
  } else if (!isApprovedModel(modelId)) {
    errors.push(`debug config resolved model "${modelId}" is not in the approved OCW-03 model catalog`);
  }
  const servers = resolved.mcp?.servers ?? resolved.mcp;
  const piSearch = servers?.pi_search;
  if (!isPlainObject(piSearch)) {
    errors.push("debug config resolved no mcp.servers.pi_search server");
  } else if (piSearch.type !== "local") {
    errors.push(
      `debug config resolved mcp.servers.pi_search.type ${JSON.stringify(piSearch.type)} instead of "local"`,
    );
  }
  if (isPlainObject(piSearch) && piSearch.codemode === false) {
    errors.push("debug config resolved mcp.servers.pi_search.codemode false (codemode must stay enabled)");
  }
  const plugins = Array.isArray(resolved.plugins) ? resolved.plugins : [];
  const hasAuditLogger = plugins.some((plugin) => {
    const value = typeof plugin === "string" ? plugin : plugin?.path ?? plugin?.id ?? plugin?.name ?? "";
    return String(value).includes("audit-logger");
  });
  if (!hasAuditLogger) {
    errors.push("debug config resolved no audit-logger plugin");
  }
  return { ok: errors.length === 0, errors };
}

function readLogFiles(logDir) {
  if (!existsSync(logDir)) return "";
  const chunks = [];
  for (const entry of readdirSync(logDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    try { chunks.push(readFileSync(join(logDir, entry.name), "utf8")); } catch { /* ignore unreadable */ }
  }
  return chunks.join("\n");
}

function sanitizeCommandOutput(text) {
  return String(text ?? "")
    .replace(/server\s+\S+/gi, "server [REDACTED]")
    .replace(/password[^\n]*/gi, "password [REDACTED]")
    .slice(0, 4000);
}

function createIsolatedConfig(sourceConfig, sourceAgents) {
  const root = mkdtempSync(join(tmpdir(), "opencode-verify-"));
  const configDir = join(root, "config", "opencode");
  mkdirSync(configDir, { recursive: true });
  copyFileSync(sourceConfig, join(configDir, "opencode.jsonc"));
  if (sourceAgents && existsSync(sourceAgents)) copyFileSync(sourceAgents, join(configDir, "AGENTS.md"));
  // A fresh, isolated audit directory: whatever the binary writes here is provably from THIS run,
  // never a historical `plugin.loaded` record left behind by an earlier session.
  const auditDir = join(root, "audit");
  mkdirSync(auditDir, { recursive: true });
  return {
    root,
    configDir,
    auditDir,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_DATA_HOME: join(root, "data"),
      XDG_CACHE_HOME: join(root, "cache"),
      XDG_STATE_HOME: join(root, "state"),
      OPENCODE_WORKFLOW_AUDIT_DIR: auditDir,
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Creates a throwaway audit directory for a live-config binary run. */
function createIsolatedAuditDir() {
  const root = mkdtempSync(join(tmpdir(), "opencode-verify-audit-"));
  const auditDir = join(root, "audit");
  mkdirSync(auditDir, { recursive: true });
  return { root, auditDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** Runs the real binary against isolated or target XDG paths. */
export function runBinaryChecks(options = {}) {
  const bin = options.opencodeBin ?? DEFAULT_OPENCODE_BIN;
  const timeout = options.timeoutMs ?? 60_000;
  const sourceConfig = resolve(options.configPath ?? join(REPO_ROOT, "config", "opencode.jsonc"));
  const sourceAgents = options.agentsPath ? resolve(options.agentsPath) : join(REPO_ROOT, "config", "AGENTS.md");
  if (!existsSync(bin)) return { ok: false, errors: [`OpenCode binary not found: ${bin}`], commands: [], pluginLog: null };

  let isolated = null;
  let env;
  let auditDir;
  let cleanup = () => {};
  if (options.configDir) {
    // Live-config run: the XDG paths stay live (that is the point of --live), but the audit
    // directory is always a throwaway one so plugin.loaded evidence cannot be satisfied by an
    // earlier run's files.
    const configDir = resolve(options.configDir);
    isolated = createIsolatedAuditDir();
    auditDir = isolated.auditDir;
    env = {
      ...process.env,
      XDG_CONFIG_HOME: dirname(configDir),
      XDG_DATA_HOME: options.dataHome ?? join(homedir(), ".local", "share"),
      XDG_CACHE_HOME: options.cacheHome ?? join(homedir(), ".cache"),
      XDG_STATE_HOME: options.stateHome ?? join(homedir(), ".local", "state"),
      OPENCODE_WORKFLOW_AUDIT_DIR: auditDir,
    };
    cleanup = () => { if (!options.keepTemp) isolated.cleanup(); };
  } else {
    if (!existsSync(sourceConfig)) return { ok: false, errors: [`Config file not found: ${sourceConfig}`], commands: [], pluginLog: null };
    isolated = createIsolatedConfig(sourceConfig, sourceAgents);
    auditDir = isolated.auditDir;
    env = isolated.env;
    cleanup = () => { if (!options.keepTemp) isolated.cleanup(); };
  }

  const commands = [];
  const errors = [];
  const warnings = [];
  // `run` keeps the raw stdout for machine parsing (the human-facing copy is sanitized and
  // truncated, so parsing it would false-negative on any real-size config), and returns only the
  // sanitized record to callers.
  const run = (label, args) => {
    const result = spawnSync(bin, args, { env, encoding: "utf8", timeout, maxBuffer: 16 * 1024 * 1024 });
    const record = {
      label,
      status: result.status,
      stdout: sanitizeCommandOutput(result.stdout),
      stderr: sanitizeCommandOutput(result.stderr),
      error: result.error ? sanitizeCommandOutput(result.error.message) : null,
    };
    commands.push(record);
    if (result.error || result.status !== 0) {
      errors.push(`${label} failed (status ${result.status ?? "spawn error"}): ${record.error ?? "see command output"}`);
    }
    return { record, raw: typeof result.stdout === "string" ? result.stdout : "" };
  };

  try {
    const configRun = run("debug config", ["--standalone", "debug", "config"]);
    const agentsRun = run("debug agents", ["--standalone", "debug", "agents"]);
    const mcpRun = run("mcp list", ["--standalone", "mcp", "list"]);
    const config = configRun.record;
    const agents = agentsRun.record;
    const mcp = mcpRun.record;

    if (config.status === 0) {
      let resolvedConfig = null;
      try {
        resolvedConfig = JSON.parse(configRun.raw);
      } catch {
        errors.push("debug config did not return JSON");
      }
      if (resolvedConfig !== null) {
        const resolved = validateResolvedConfig(resolvedConfig);
        errors.push(...resolved.errors);
      }
    }
    if (agents.status === 0) {
      try {
        const parsed = JSON.parse(agentsRun.raw);
        const ids = new Set(Array.isArray(parsed) ? parsed.map((agent) => agent.id ?? agent.name) : []);
        const missing = REQUIRED_AGENTS.filter((name) => !ids.has(name));
        if (missing.length) errors.push(`debug agents is missing: ${missing.join(", ")}`);
      } catch {
        errors.push("debug agents did not return JSON");
      }
    }
    if (mcp.status === 0 && !/pi_search/i.test(mcp.stdout)) {
      warnings.push("mcp list did not show pi_search (known 2.3.2 materialization gap; config itself is validated above)");
    }
    const mcpList = {
      status: mcp.status,
      hasPiSearch: /pi_search/i.test(mcp.stdout),
      output: mcp.stdout.trim(),
    };

    // Plugin-load evidence is mandatory for a real binary run: a missing log or a missing
    // `plugin.loaded` record means we cannot prove the audit plugin is active at all, which is a
    // verification failure (not a warning we can shrug off).
    const logDir = join(env.XDG_DATA_HOME, "opencode", "log");
    const logText = readLogFiles(logDir);
    const pluginLog = inspectPluginLoadLog(logText);
    if (!pluginLog.ok) {
      errors.push(`OpenCode logged ${pluginLog.count} failed-to-load-plugin error(s) for the audit plugin`);
    }
    if (logText.trim().length === 0) {
      errors.push(`No OpenCode log was found at ${logDir}; plugin-load evidence is required for a binary run`);
    }

    const auditEvidence = inspectAuditEvidence(auditDir);
    if (auditEvidence.pluginLoaded === 0) {
      errors.push(`No plugin.loaded record was written to the isolated audit directory ${auditDir}; the audit plugin did not prove it loaded`);
    }
    errors.push(...auditEvidence.errors);

    return { ok: errors.length === 0, errors, warnings, commands, pluginLog, logDir, mcpList, auditDir, auditEvidence }; 
  } finally {
    cleanup();
  }
}

/** Optional live schema check. Only --schema triggers this network call. */
export async function checkSchema(config, options = {}) {
  const url = options.schemaUrl ?? DEFAULT_SCHEMA_URL;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") return { ok: false, errors: ["No fetch implementation for --schema"], schemaUrl: url };
  const errors = [];
  const warnings = [];
  try {
    const response = await fetchImpl(url, { headers: { accept: "application/json" } });
    if (!response.ok) return { ok: false, errors: [`Schema fetch failed: HTTP ${response.status}`], schemaUrl: url };
    const schema = await response.json();
    const properties = schema?.properties && typeof schema.properties === "object" ? schema.properties : {};
    const known = new Set(Object.keys(properties));
    for (const key of Object.keys(config)) {
      if (key === "$schema") continue;
      if (!known.has(key)) errors.push(`Config key not present in live schema: ${key}`);
    }
    for (const [key, property] of Object.entries(properties)) {
      if (!(key in config) || key === "$schema") continue;
      const type = property?.type;
      const value = config[key];
      if (type === "object" && (value === null || typeof value !== "object" || Array.isArray(value))) errors.push(`${key} should be an object`);
      if (type === "array" && !Array.isArray(value)) errors.push(`${key} should be an array`);
      if (type === "string" && typeof value !== "string") errors.push(`${key} should be a string`);
      if (type === "boolean" && typeof value !== "boolean") errors.push(`${key} should be a boolean`);
    }
    if (!Object.keys(properties).length) warnings.push("Live schema had no top-level properties; only reachability was checked");
    return { ok: errors.length === 0, errors, warnings, schemaUrl: url };
  } catch (error) {
    return { ok: false, errors: [`Schema check failed: ${error?.message ?? error}`], schemaUrl: url };
  }
}

/** Full verification; `binary:false` keeps automated tests fully offline. */
export async function verifySetup(options = {}) {
  // `--live` verifies the config actually installed in ~/.config/opencode instead of the
  // repository copy staged into an isolated XDG tree.
  const liveDir = resolve(join(homedir(), ".config", "opencode"));
  const live = Boolean(options.live);
  const configPath = resolve(options.configPath ?? (live ? join(liveDir, "opencode.jsonc") : join(REPO_ROOT, "config", "opencode.jsonc")));
  const agentsPath = resolve(options.agentsPath ?? (live ? join(liveDir, "AGENTS.md") : join(REPO_ROOT, "config", "AGENTS.md")));
  const errors = [];
  const warnings = [];
  const checks = [];
  let config = null;

  if (!existsSync(configPath)) {
    errors.push(`Config file not found: ${configPath}`);
  } else {
    try {
      config = parseJsonc(readFileSync(configPath, "utf8"));
      checks.push(`JSONC parse: pass (${basename(configPath)})`);
    } catch (error) {
      errors.push(error?.message ?? String(error));
    }
  }

  let configValidation = null;
  if (config) {
    configValidation = validateConfig(config);
    errors.push(...configValidation.errors);
    warnings.push(...configValidation.warnings);
    checks.push(...configValidation.checks);
  }

  const agentsValidation = validateAgentsFile(agentsPath);
  errors.push(...agentsValidation.errors);
  warnings.push(...agentsValidation.warnings);
  if (agentsValidation.ok) checks.push(`AGENTS.md size: pass (${agentsValidation.chars} <= ${AGENTS_HARD_CHARS} chars)`);

  let binary = null;
  let audit = null;
  if (options.binary !== false) {
    binary = runBinaryChecks({
      ...options,
      configPath,
      agentsPath,
      configDir: options.configDir ?? (live ? liveDir : undefined),
    });
    errors.push(...binary.errors);
    warnings.push(...binary.warnings);
    // Audit evidence for a binary run always comes from that run's isolated audit directory, never
    // from a historical directory that may hold an old plugin.loaded record.
    audit = binary.auditEvidence ?? null;
    if (audit && audit.pluginLoaded > 0 && audit.ok) {
      checks.push(`Audit plugin evidence: pass (${audit.pluginLoaded} plugin.loaded record(s) in the isolated run directory)`);
    }
    if (binary.ok) checks.push("OpenCode binary checks: pass (debug config, debug agents, mcp list, plugin log, plugin.loaded evidence)");
  } else {
    if (options.auditDir) {
      audit = inspectAuditEvidence(resolve(options.auditDir));
      errors.push(...audit.errors);
      if (!audit.ok) warnings.push(...audit.warnings);
    }
    warnings.push("OpenCode binary checks skipped (binary:false/--skip-binary): plugin.loaded evidence was not proven by an isolated binary run");
  }

  let schema = null;
  if (options.schema) {
    schema = await checkSchema(config ?? {}, options);
    errors.push(...schema.errors);
    warnings.push(...schema.warnings);
    if (schema.ok) checks.push(`Live schema check: pass (${schema.schemaUrl})`);
  }

  return {
    ok: errors.length === 0,
    live,
    configPath,
    agentsPath,
    checks,
    errors,
    warnings,
    configValidation,
    agentsValidation,
    binary,
    audit,
    schema,
  };
}

function parseCliArgs(argv) {
  const options = { schema: false, binary: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${arg} requires a value`);
      return argv[i];
    };
    if (arg === "--config") options.configPath = next();
    else if (arg === "--agents") options.agentsPath = next();
    else if (arg === "--target-dir") options.configDir = next();
    else if (arg === "--opencode-bin") options.opencodeBin = next();
    else if (arg === "--schema") options.schema = true;
    else if (arg === "--live") options.live = true;
    else if (arg === "--audit-dir") options.auditDir = next();
    else if (arg === "--skip-binary") options.binary = false;
    else if (arg === "--keep-temp") options.keepTemp = true;
    else if (arg === "--json") options.json = true;
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
    console.log("Usage: node scripts/verify-setup.mjs [--config FILE] [--agents FILE] [--target-dir DIR] [--live] [--audit-dir DIR] [--schema] [--skip-binary] [--json]");
    console.log("  --audit-dir DIR is only read when --skip-binary is used; binary runs always prove plugin.loaded from their own isolated temp audit directory.");
    return;
  }
  const result = await verifySetup(options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    console.log(`Verify ${result.ok ? "PASS" : "FAIL"} — ${result.configPath}${result.live ? " (live)" : ""}`);
    for (const check of result.checks) console.log(`  PASS ${check}`);
    for (const warning of result.warnings) console.log(`  WARN ${warning}`);
    for (const error of result.errors) console.log(`  FAIL ${error}`);
    if (result.binary?.commands) {
      for (const command of result.binary.commands) console.log(`  ${command.label}: exit ${command.status}`);
    }
    if (result.binary?.mcpList) {
      const first = result.binary.mcpList.output.split("\n")[0] || "(no output)";
      console.log(`  mcp list: pi_search ${result.binary.mcpList.hasPiSearch ? "listed" : "NOT listed"} — ${first}`);
    }
  }
  if (!result.ok) process.exitCode = 1;
}

if (isMainModule()) {
  main().catch((error) => {
    console.error(`verify-setup: ${error?.message ?? error}`);
    process.exitCode = 1;
  });
}

export const VERIFY_INTERNALS = Object.freeze({
  globToRegExp,
  lastMatchingRule,
  createIsolatedConfig,
  sanitizeCommandOutput,
  validateResolvedConfig,
  unwrapResolvedConfig,
  resolvedModelId,
  isApprovedModel,
  normalizeModelId,
});
