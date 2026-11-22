#!/usr/bin/env node
// Model Shootout runner.
//
// Runs every (model, task) pair through OpenCode v2.3.2 headless mode in a fully isolated
// workspace, then scores the finished code/answer with the hidden oracles in `scorers.mjs`.
//
// Isolation (why each run gets its own everything):
//   * a fresh temp git repo with one initial commit, so diffs/scope checks are exact
//   * its own XDG_CONFIG_HOME / XDG_DATA_HOME / XDG_STATE_HOME / XDG_CACHE_HOME plus a minimal
//     opencode.jsonc (no MCP servers, no plugins, allow-all local permissions, `--auto`) so a
//     parallel `--standalone` invocation never touches the live SQLite database or hangs on an
//     interactive approval prompt
//   * the OpenRouter credential is copied into the isolated data dir (read-only copy; the live
//     `~/.config/opencode` and `~/.local/share/opencode` are never written)
//
// Budget safety is layered:
//   1. a pre-run guard: `spent + safetyReserve >= budget` refuses new runs
//   2. a preflight estimate: a run whose worst-case estimate exceeds `--per-run-cap-usd` is skipped
//   3. a streaming kill: while the run is in flight, reported cost is tallied per event and the
//      process is killed if it would cross the per-run cap or the remaining total budget
//   4. post-run reconciliation: measured cost is added to `spent` before the next launch decision
//
// This file has no network calls of its own: it shells out to the `opencode` binary only when
// `--dry-run` is absent.

import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CATALOG_SOURCE,
  formatRosterTable,
  modelId,
  pricingFor,
  selectModels,
  verifyAgainstCatalog,
} from "./roster.mjs";
import { createTaskRepo, git, installHidden, selectTasks } from "./tasks.mjs";
import {
  PASS_THRESHOLD,
  extractFileRefs,
  extractMetrics,
  gitStatusEntries,
  parseRunOutput,
  renderLeaderboard,
  scoreTask,
  summarizeRuns,
  toolTouchedText,
} from "./scorers.mjs";

/** Default budget in USD. Approved hard cap for the full 50-run sweep. */
export const DEFAULT_BUDGET_USD = 5.0;

/** Default per-run cap in USD. */
export const DEFAULT_PER_RUN_CAP_USD = 0.6;

/** Default wall-clock limit for one (model, task) run. */
export const DEFAULT_TIMEOUT_SEC = 180;

/** Default parallelism. Each run is isolated, so this is safe. */
export const DEFAULT_CONCURRENCY = 4;

/** Token assumptions for the preflight worst-case estimate (tasks are small). */
export const DEFAULT_ESTIMATE_INPUT_TOKENS = 25_000;
export const DEFAULT_ESTIMATE_OUTPUT_TOKENS = 4_000;

/** Default OpenCode binary. */
export const DEFAULT_OPENCODE_BIN = "/root/.opencode/bin/opencode";

/**
 * Minimal, constant-harness config for one run's isolated XDG config dir.
 *
 * Allow-all keeps the harness from stalling on approval prompts (`--auto` covers the rest), then a
 * handful of later-wins rules wall the model inside its own workspace: file tools cannot read the
 * live config, this repo's harness sources (which contain the hidden oracles), or another run's
 * workspace, and shell commands mentioning those paths are denied. Subagents and interactive
 * questions are denied so the measurement stays single-agent and never blocks.
 */
export function isolatedConfig(repoDir) {
  const root = String(repoDir).replace(/\/+$/, "");
  const scratchRoots = [...new Set(["/tmp", tmpdir()])];
  const rules = [
    { action: "*", resource: "*", effect: "allow" },
    { action: "subagent", resource: "*", effect: "deny" },
    { action: "question", resource: "*", effect: "deny" },
    // External surfaces stay off so the harness is constant, offline and unmetered beyond tokens.
    { action: "websearch", resource: "*", effect: "deny" },
    { action: "webfetch", resource: "*", effect: "deny" },
    { action: "experimental_image_generate", resource: "*", effect: "deny" },
    { action: "bash", resource: "*/root/*", effect: "deny" },
    { action: "shell", resource: "*/root/*", effect: "deny" },
    { action: "bash", resource: "*bench/shootout*", effect: "deny" },
    { action: "shell", resource: "*bench/shootout*", effect: "deny" },
  ];
  // Scratch roots are denied so a run cannot read a sibling run's workspace (which holds the
  // already-installed hidden oracles); the workspace itself is re-allowed below.
  for (const scratch of scratchRoots) {
    rules.push({ action: "bash", resource: `*${scratch}/*`, effect: "deny" });
    rules.push({ action: "shell", resource: `*${scratch}/*`, effect: "deny" });
    for (const action of ["read", "edit", "write", "patch", "glob", "grep"]) {
      rules.push({ action, resource: `${scratch}/**`, effect: "deny" });
    }
  }
  for (const action of ["read", "edit", "write", "patch", "glob", "grep"]) {
    rules.push({ action, resource: "/root/**", effect: "deny" });
    rules.push({ action, resource: "/root", effect: "deny" });
    // Later rules win, so the workspace itself is re-allowed after every deny sweep.
    rules.push({ action, resource: `${root}/**`, effect: "allow" });
    rules.push({ action, resource: root, effect: "allow" });
  }
  // The workspace allow is needed (the workspace itself sits under a denied scratch root), but a
  // `*<workspace>*` match is a substring test on the command string: a command that mentions the
  // workspace AND escapes it passed. The final block re-denies the escapes unconditionally, because
  // later rules win.
  rules.push({ action: "bash", resource: `*${root}*`, effect: "allow" });
  rules.push({ action: "shell", resource: `*${root}*`, effect: "allow" });
  for (const action of ["bash", "shell"]) {
    // Lexical parent traversal: no command may step out of its own workspace with `../`.
    rules.push({ action, resource: "*../*", effect: "deny" });
    rules.push({ action, resource: "* ..*", effect: "deny" });
    rules.push({ action, resource: "..", effect: "deny" });
    // Harness sources (hidden oracles) and the live config stay unreachable even for a command that
    // also mentions its own workspace.
    rules.push({ action, resource: "*bench/shootout*", effect: "deny" });
    rules.push({ action, resource: "*/root/*", effect: "deny" });
  }
  return [
    "{",
    "  // Model Shootout: constant harness, walled to this run's workspace.",
    '  "$schema": "https://opencode.ai/config.json",',
    '  "default_agent": "build",',
    `  "permissions": ${JSON.stringify(rules, null, 2).split("\n").join("\n  ")},`,
    '  "mcp": { "servers": {} }',
    "}",
  ].join("\n");
}

/** Backwards-compatible template for docs/tests that only need the shape. */
export const ISOLATED_CONFIG = isolatedConfig("<workspace>");

const HELP = `Model Shootout — run N models x 5 tasks through OpenCode, score, report.

Usage: node bench/shootout/runner.mjs [flags]

Flags:
  --budget-usd <n>            hard cumulative spend cap (default ${DEFAULT_BUDGET_USD})
  --per-run-cap-usd <n>       cap for a single run (default ${DEFAULT_PER_RUN_CAP_USD})
  --safety-reserve-usd <n>    headroom kept below the budget (default: 5% of budget, capped at the per-run cap)
  --timeout-sec <n>           wall-clock limit per run (default ${DEFAULT_TIMEOUT_SEC})
  --concurrency <n>           parallel runs (default ${DEFAULT_CONCURRENCY})
  --models <csv>              roster keys or full model ids (default: all 10)
  --tasks <csv>               task ids T1..T5 or keys (default: all 5)
  --out-dir <path>            output dir (default artifacts/shootout-<timestamp>/)
  --opencode-bin <path>       OpenCode binary (default ${DEFAULT_OPENCODE_BIN})
  --estimate-input-tokens <n> preflight input token assumption (default ${DEFAULT_ESTIMATE_INPUT_TOKENS})
  --estimate-output-tokens <n> preflight output token assumption (default ${DEFAULT_ESTIMATE_OUTPUT_TOKENS})
  --keep-temp                 keep per-run temp repos/configs after scoring
  --dry-run                   print the plan (roster, tasks, estimated cost) and exit
  --help                      show this help
`;

/* ------------------------------------------------------------------------------------------------
 * Argument parsing
 * ---------------------------------------------------------------------------------------------- */

function numberArg(raw, flag, { min = 0 } = {}) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min) {
    throw new Error(`${flag} expects a number >= ${min}, got "${raw}"`);
  }
  return value;
}

/** Parse CLI flags into a normalized options object. */
export function parseArgs(argv) {
  const options = {
    budgetUsd: DEFAULT_BUDGET_USD,
    perRunCapUsd: DEFAULT_PER_RUN_CAP_USD,
    safetyReserveUsd: null,
    timeoutSec: DEFAULT_TIMEOUT_SEC,
    concurrency: DEFAULT_CONCURRENCY,
    models: null,
    tasks: null,
    outDir: null,
    opencodeBin: DEFAULT_OPENCODE_BIN,
    estimateInputTokens: DEFAULT_ESTIMATE_INPUT_TOKENS,
    estimateOutputTokens: DEFAULT_ESTIMATE_OUTPUT_TOKENS,
    keepTemp: false,
    dryRun: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${arg} expects a value`);
      return argv[index];
    };
    switch (arg) {
      case "--budget-usd":
        options.budgetUsd = numberArg(next(), arg, { min: 0 });
        break;
      case "--per-run-cap-usd":
        options.perRunCapUsd = numberArg(next(), arg, { min: 0 });
        break;
      case "--safety-reserve-usd":
        options.safetyReserveUsd = numberArg(next(), arg, { min: 0 });
        break;
      case "--timeout-sec":
        options.timeoutSec = numberArg(next(), arg, { min: 1 });
        break;
      case "--concurrency":
        options.concurrency = Math.max(1, Math.trunc(numberArg(next(), arg, { min: 1 })));
        break;
      case "--models":
        options.models = next();
        break;
      case "--tasks":
        options.tasks = next();
        break;
      case "--out-dir":
        options.outDir = next();
        break;
      case "--opencode-bin":
        options.opencodeBin = next();
        break;
      case "--estimate-input-tokens":
        options.estimateInputTokens = Math.trunc(numberArg(next(), arg, { min: 1 }));
        break;
      case "--estimate-output-tokens":
        options.estimateOutputTokens = Math.trunc(numberArg(next(), arg, { min: 1 }));
        break;
      case "--keep-temp":
        options.keepTemp = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`unknown flag "${arg}" (see --help)`);
    }
  }
  if (options.safetyReserveUsd === null) {
    // Keep one per-run's worth of headroom when affordable, never more than 5% of the budget.
    options.safetyReserveUsd = Math.min(options.perRunCapUsd, options.budgetUsd * 0.05);
  }
  return options;
}

/* ------------------------------------------------------------------------------------------------
 * Cost helpers
 * ---------------------------------------------------------------------------------------------- */

/** Worst-case preflight cost estimate for one run (USD). */
export function estimateRunCost(
  entry,
  { inputTokens, outputTokens, estimateInputTokens, estimateOutputTokens } = {},
) {
  const pricing = pricingFor(entry) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const input = inputTokens ?? estimateInputTokens ?? DEFAULT_ESTIMATE_INPUT_TOKENS;
  const output = outputTokens ?? estimateOutputTokens ?? DEFAULT_ESTIMATE_OUTPUT_TOKENS;
  const cost = (input * pricing.input + output * pricing.output) / 1_000_000;
  return Number(cost.toFixed(4));
}

/**
 * Tracks in-flight cost from the JSON stream so a runaway run can be killed before it eats the
 * budget. Cost is accounted per step: reported costs and token-based estimates are summed per step
 * instead of "any reported cost discards every estimate", so a provider that reports cost for only
 * some steps cannot under-report the run.
 */
export class CostTracker {
  constructor({ pricing = null, perRunCapUsd = Infinity, remainingBudgetUsd = Infinity }) {
    this.pricing = pricing;
    this.perRunCapUsd = perRunCapUsd;
    this.remainingBudgetUsd = remainingBudgetUsd;
    this.reported = 0;
    this.estimated = 0;
    this.buffer = "";
  }

  get costUsd() {
    return Number((this.reported + this.estimated).toFixed(6));
  }

  get limitUsd() {
    return Math.min(this.perRunCapUsd, this.remainingBudgetUsd);
  }

  get exceeded() {
    return this.costUsd >= this.limitUsd;
  }

  /** Feed a stdout chunk; returns true when the caller should kill the process. */
  push(chunk) {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) this.#consumeLine(line);
    return this.exceeded;
  }

  #consumeLine(line) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return;
    let frame;
    try {
      frame = JSON.parse(trimmed);
    } catch {
      return;
    }
    const metrics = extractMetrics({ frames: [frame], pricing: this.pricing });
    if (metrics.reportedCostUsd !== null) this.reported += metrics.reportedCostUsd;
    this.estimated += metrics.estimatedCostUsd;
  }
}

/* ------------------------------------------------------------------------------------------------
 * Environment / workspace preparation
 * ---------------------------------------------------------------------------------------------- */

/** Locate the live OpenCode credential file without modifying it. */
export function findAuthSource() {
  const candidates = [
    process.env.XDG_DATA_HOME ? join(process.env.XDG_DATA_HOME, "opencode", "auth.json") : null,
    join(homedir(), ".local", "share", "opencode", "auth.json"),
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/**
 * Build one run's isolated environment: temp repo (fresh fixture + initial commit) and temp XDG
 * dirs containing a minimal config plus a copied credential.
 */
export function prepareRunWorkspace({ task, runDir, authSource = findAuthSource() }) {
  rmSync(runDir, { recursive: true, force: true });
  const repoDir = join(runDir, "repo");
  const xdg = {
    config: join(runDir, "xdg", "config"),
    data: join(runDir, "xdg", "data"),
    state: join(runDir, "xdg", "state"),
    cache: join(runDir, "xdg", "cache"),
  };
  createTaskRepo(task, repoDir, { commit: true });
  mkdirSync(join(xdg.config, "opencode"), { recursive: true });
  writeFileSync(join(xdg.config, "opencode", "opencode.jsonc"), isolatedConfig(repoDir), "utf8");
  for (const dir of [xdg.data, xdg.state, xdg.cache]) mkdirSync(dir, { recursive: true });
  let authCopied = false;
  if (authSource) {
    const targetDir = join(xdg.data, "opencode");
    mkdirSync(targetDir, { recursive: true });
    copyFileSync(authSource, join(targetDir, "auth.json"));
    authCopied = true;
  }
  return { repoDir, xdg, authCopied };
}

/**
 * Exactly the parent variables a headless OpenCode run needs.
 *
 * The child used to inherit the whole parent environment, which handed every model process the
 * caller's credentials, tokens and paths (any unrelated API key in the shell that launched the
 * sweep). Only these keys are forwarded; everything else is dropped.
 */
export const ALLOWED_CHILD_ENV = [
  "PATH",
  "HOME",
  "NODE_ENV",
  "TERM",
  "OPENROUTER_API_KEY",
];

/** Environment variables for a `--standalone` run pinned to the isolated XDG dirs. */
export function buildRunEnv(xdg, baseEnv = process.env, repoDir = null) {
  const env = {};
  for (const key of ALLOWED_CHILD_ENV) {
    if (typeof baseEnv[key] === "string") env[key] = baseEnv[key];
  }
  // `XDG_*` are in the allowlist but every one the harness sets is overwritten below; copying them
  // first keeps unrelated XDG variables (e.g. XDG_RUNTIME_DIR) working without passing anything else.
  for (const [key, value] of Object.entries(baseEnv)) {
    if (key.startsWith("XDG_") && typeof value === "string") env[key] = value;
  }
  env.XDG_CONFIG_HOME = xdg.config;
  env.XDG_DATA_HOME = xdg.data;
  env.XDG_STATE_HOME = xdg.state;
  env.XDG_CACHE_HOME = xdg.cache;
  env.OPENCODE_CONFIG_DIR = join(xdg.config, "opencode");
  env.NO_COLOR = "1";
  // The child's real cwd is the temp workspace, but an inherited PWD makes OpenCode resolve the
  // session directory (and shell workdir) to the caller's directory instead. Pin it.
  if (repoDir) {
    env.PWD = repoDir;
    delete env.OLDPWD;
  }
  return env;
}

/** The exact argv used for a headless run (verified against OpenCode v2.3.2 `run --help`). */
export function buildRunArgs({ model, prompt, title }) {
  return [
    "--standalone",
    "--log-level",
    "error",
    "run",
    "--format",
    "json",
    "--model",
    model,
    "--auto",
    "--archived",
    "--title",
    title,
    prompt,
  ];
}

/* ------------------------------------------------------------------------------------------------
 * One run
 * ---------------------------------------------------------------------------------------------- */

const nowIso = () => new Date().toISOString();

/**
 * Execute a single (model, task) run: workspace, OpenCode process, parse, oracle, score.
 * `deps.exec` is injectable so the offline tests can exercise the budget guard without a binary.
 */
export async function executeRun({
  entry,
  task,
  options,
  runDir,
  spentUsd,
  deps = {},
}) {
  const exec = deps.exec ?? defaultExec;
  const authSource = deps.authSource ?? findAuthSource();
  const workspace = prepareRunWorkspace({ task, runDir, authSource });
  const startedAt = Date.now();
  const model = modelId(entry);
  const remaining = Math.max(0, options.budgetUsd - spentUsd);

  const outcome = await exec({
    model,
    task,
    entry,
    options,
    repoDir: workspace.repoDir,
    xdg: workspace.xdg,
    env: buildRunEnv(workspace.xdg, deps.baseEnv ?? process.env, workspace.repoDir),
    args: buildRunArgs({ model, prompt: task.prompt, title: `shootout ${task.id} ${entry.key}` }),
    remainingBudgetUsd: remaining,
  });

  const durationMs = outcome.durationMs ?? Date.now() - startedAt;
  const metrics = parseRunOutput({
    stdout: outcome.stdout ?? "",
    pricing: pricingFor(entry),
    durationMs,
  });
  if (outcome.metrics?.costUsd) {
    // A mocked/short-circuited executor may hand back metrics directly.
    metrics.costUsd = outcome.metrics.costUsd;
    metrics.costSource = "injected";
  }
  if (outcome.streamedCostUsd && outcome.streamedCostUsd > metrics.costUsd) {
    metrics.costUsd = outcome.streamedCostUsd;
    metrics.costSource = "streamed";
  }

  // Hidden oracles are installed only now — the model never sees them.
  installHidden(task, workspace.repoDir);

  // Persist the raw event stream next to the scored result so the trace is auditable.
  const rawPath = join(runDir, "stdout.jsonl");
  writeFileSync(rawPath, String(outcome.stdout ?? ""), "utf8");

  const finishedAt = Date.now();
  const finalText = metrics.finalAnswer || outcome.finalText || "";
  const run = {
    runId: `${entry.key}__${task.id}`,
    model,
    modelKey: entry.key,
    tier: entry.tier,
    taskId: task.id,
    taskKey: task.key,
    status: outcome.status ?? "ok",
    tempRetained: null,
    authDeleted: null,
    error: outcome.error ?? null,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    durationMs,
    overPerRunCap: metrics.costUsd > options.perRunCapUsd,
    metrics,
    finalText,
    checks: [],
    score: 0,
    result: null,
    repoDir: workspace.repoDir,
    authCopied: workspace.authCopied,
    opencodeArgs: buildRunArgs({ model, prompt: "<fixture prompt>", title: `shootout ${task.id} ${entry.key}` }),
    stderrTail: String(outcome.stderr ?? "").slice(-4000),
    stdoutTail: String(outcome.stdout ?? "").slice(-4000),
    rawTracePath: rawPath,
  };

  if (run.status !== "spawn-error") {
    // Score even a failed/aborted run so the diagnostics are recorded; `passed` still requires
    // status === 'ok', so an aborted run can never inflate the leaderboard.
    try {
      const result = scoreTask({
        task,
        repoDir: workspace.repoDir,
        metrics,
        finalText,
      });
      run.result = result;
      run.score = result.score;
      run.checks = result.checks;
    } catch (error) {
      run.status = "scoring-error";
      run.error = `${error.message}`;
    }
  }

  run.passed = run.status === "ok" && run.score >= PASS_THRESHOLD;
  const sessionError = metrics.errors.find((entry) => entry.tool === "session");
  if (!run.error && sessionError) {
    run.error = `session error: ${sessionError.error}`;
  }
  run.gitStatus = gitStatusEntries(workspace.repoDir);
  run.toolTouchedText = toolTouchedText(metrics).slice(0, 4000);
  run.fileRefs = extractFileRefs(finalText);

  // Credential and scratch hygiene happens last, once nothing else needs the workspace.
  Object.assign(run, cleanupRunWorkspace({ runDir, workspace, keepTemp: Boolean(options.keepTemp) }));
  return run;
}

/**
 * Credential and scratch hygiene for one finished run.
 *
 * The copied `auth.json` is deleted unconditionally (a live credential must never linger in a temp
 * XDG dir or in `artifacts/`), and the whole temp workspace (repo + isolated XDG roots) is deleted
 * unless the caller asks for it with `--keep-temp`. Only the sanitized run JSON and the raw
 * `stdout.jsonl` survive, which is everything needed to audit a score.
 */
export function cleanupRunWorkspace({ runDir, workspace, keepTemp = false }) {
  const authPath = join(workspace.xdg.data, "opencode", "auth.json");
  const authDeleted = existsSync(authPath);
  rmSync(authPath, { force: true });
  if (keepTemp) return { authDeleted, tempRetained: true };
  for (const dir of [workspace.repoDir, join(runDir, "xdg")]) {
    rmSync(dir, { recursive: true, force: true });
  }
  return { authDeleted, tempRetained: false };
}

/** Default executor: spawn OpenCode headless with a timeout and a streaming cost kill. */
export function defaultExec({ entry, options, repoDir, env, args, remainingBudgetUsd }) {
  return new Promise((resolvePromise) => {
    const tracker = new CostTracker({
      pricing: pricingFor(entry),
      perRunCapUsd: options.perRunCapUsd,
      remainingBudgetUsd,
    });
    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    let killedFor = null;
    let settled = false;

    const child = spawn(options.opencodeBin, args, {
      cwd: repoDir,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const kill = (reason) => {
      if (killedFor) return;
      killedFor = reason;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    };

    const timeout = setTimeout(() => kill("timeout"), options.timeoutSec * 1000);

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stdout += text;
      if (tracker.push(text)) kill("cost-cap");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    const finish = (status, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const finalStatus = error === "timeout" ? "timeout" : error === "cost-cap" ? "cost-cap" : status;
      resolvePromise({
        status: finalStatus,
        error: finalStatus === "ok" ? null : error ?? null,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        streamedCostUsd: tracker.costUsd,
      });
    };

    child.on("error", (error) => finish("error", `spawn failed: ${error.message}`));
    child.on("close", (code) => {
      if (killedFor) return finish("killed", killedFor);
      if (code === 0) return finish("ok", null);
      finish("error", `opencode exited with code ${code}`);
    });
  });
}

/* ------------------------------------------------------------------------------------------------
 * Orchestration
 * ---------------------------------------------------------------------------------------------- */

/** Build the (model, task) plan honouring the budget guard. Pure, so tests can inspect it. */
export function planRuns({ models, tasks, options }) {
  const plan = [];
  for (const entry of models) {
    for (const task of tasks) {
      plan.push({
        entry,
        task,
        runId: `${entry.key}__${task.id}`,
        estimateUsd: estimateRunCost(entry, {
          inputTokens: options.estimateInputTokens,
          outputTokens: options.estimateOutputTokens,
        }),
      });
    }
  }
  return plan;
}

/** Should another run be started? (Single-run guard; `canReserveRun` is the concurrency-safe one.) */
export function canStartRun({ spentUsd, options }) {
  return spentUsd + options.safetyReserveUsd < options.budgetUsd;
}

/**
 * Concurrency-safe budget admission: a run may only start when its own worst-case reservation,
 * every other in-flight reservation and the safety reserve all still fit under the hard cap.
 *
 * Without this, N workers could each pass the "money spent so far" check and then all spend up to
 * the per-run cap concurrently, overshooting the budget by up to (N - 1) x perRunCapUsd.
 */
export function canReserveRun({ spentUsd = 0, inFlightReservedUsd = 0, reserveUsd = 0, options }) {
  return (
    spentUsd + inFlightReservedUsd + reserveUsd + options.safetyReserveUsd <=
    options.budgetUsd + 1e-9
  );
}

/** Default location of the on-disk OpenCode model catalog. */
export const DEFAULT_CATALOG_PATH = "/root/.cache/opencode/models.json";

/** Read the OpenCode catalog, or return null when it is not on disk (offline/CI). */
export function loadCatalog(catalogPath = DEFAULT_CATALOG_PATH) {
  try {
    return JSON.parse(readFileSync(catalogPath, "utf8"));
  } catch {
    return null;
  }
}

/** Git provenance of the harness checkout, so a report can be tied to exact sources. */
export function readGitInfo(cwd = process.cwd()) {
  try {
    const commit = git(cwd, ["rev-parse", "HEAD"]) || null;
    const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]) || null;
    const status = gitStatusEntries(cwd);
    return { commit, branch, dirty: status.clean ? false : true, error: status.error };
  } catch (error) {
    return { commit: null, branch: null, dirty: null, error: `${error.message}` };
  }
}

/**
 * Run the sweep. Returns the full summary object and writes artifacts.
 * `deps.exec` may be injected; everything else is real.
 */
export async function runShootout(options, deps = {}) {
  const models = selectModels(options.models);
  const tasks = selectTasks(options.tasks);
  const plan = planRuns({ models, tasks, options });

  // The roster is cross-checked against the on-disk catalog before any paid run starts. A missing
  // catalog is recorded as a warning (offline machines still get a usable run), but a catalog that
  // contradicts the roster stops the sweep before a single token is spent.
  const catalog = deps.catalog !== undefined ? deps.catalog : loadCatalog(deps.catalogPath);
  const catalogCheck = catalog
    ? verifyAgainstCatalog(models, catalog)
    : {
        available: false,
        ok: false,
        checked: [],
        problems: [`catalog not readable at ${deps.catalogPath ?? DEFAULT_CATALOG_PATH}`],
      };
  if (catalogCheck.available && !catalogCheck.ok) {
    throw new Error(
      `roster/catalog mismatch — refusing to start paid runs: ${catalogCheck.problems.join("; ")}`,
    );
  }

  const startedAt = new Date();
  const gitInfo = deps.gitInfo ?? readGitInfo(deps.gitRoot);
  const outDir = resolve(
    options.outDir ??
      join(process.cwd(), "artifacts", `shootout-${startedAt.toISOString().replace(/[:.]/g, "-")}`),
  );
  mkdirSync(join(outDir, "runs"), { recursive: true });

  const runs = [];
  const skipped = [];
  let spentUsd = 0;
  let inFlightReservedUsd = 0;
  let stopReason = null;
  let nextIndex = 0;

  const worker = async () => {
    for (;;) {
      if (stopReason) return;
      const index = nextIndex;
      if (index >= plan.length) return;
      const item = plan[index];
      if (item.estimateUsd > options.perRunCapUsd) {
        nextIndex += 1;
        skipped.push({
          runId: item.runId,
          reason: "preflight-estimate-over-per-run-cap",
          estimateUsd: item.estimateUsd,
          perRunCapUsd: options.perRunCapUsd,
        });
        continue;
      }
      // Reserve the run's worst case BEFORE spawning it. The check and the reservation happen in
      // the same synchronous step, so two concurrent workers can never both pass the guard.
      const reserveUsd = Math.max(options.perRunCapUsd, item.estimateUsd);
      if (!canReserveRun({ spentUsd, inFlightReservedUsd, reserveUsd, options })) {
        stopReason = "budget";
        return;
      }
      nextIndex += 1;
      inFlightReservedUsd += reserveUsd;
      const runDir = join(outDir, "runs", item.runId);
      let run;
      try {
        run = await executeRun({
          entry: item.entry,
          task: item.task,
          options,
          runDir,
          spentUsd,
          deps,
        });
      } finally {
        // Release the reservation and reconcile with the measured cost before the next decision.
        inFlightReservedUsd -= reserveUsd;
      }
      run.estimateUsd = item.estimateUsd;
      spentUsd += run.metrics.costUsd ?? 0;
      runs.push(run);
      writeFileSync(join(outDir, "runs", `${item.runId}.json`), JSON.stringify(serializeRun(run), null, 2), "utf8");
      const state = run.status === "ok" ? (run.passed ? "PASS" : "fail") : run.status;
      process.stdout.write(
        `[${runs.length}/${plan.length}] ${item.runId.padEnd(38)} ${state.padEnd(10)} score=${run.score.toFixed(2)} cost=$${run.metrics.costUsd.toFixed(4)} spent=$${spentUsd.toFixed(4)}\n`,
      );
    }
  };

  const workers = Array.from({ length: Math.min(options.concurrency, Math.max(1, plan.length)) }, () =>
    worker(),
  );
  await Promise.all(workers);
  if (!stopReason && nextIndex >= plan.length) stopReason = "complete";

  const finishedAt = new Date();
  const leaderboard = summarizeRuns(runs);
  const summary = {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    budgetUsd: options.budgetUsd,
    perRunCapUsd: options.perRunCapUsd,
    safetyReserveUsd: options.safetyReserveUsd,
    timeoutSec: options.timeoutSec,
    concurrency: options.concurrency,
    models: models.map((entry) => ({ key: entry.key, model: modelId(entry), tier: entry.tier })),
    tasks: tasks.map((task) => ({ id: task.id, key: task.key })),
    plannedRuns: plan.length,
    startedRuns: runs.length,
    skipped,
    stopReason,
    git: gitInfo,
    catalogCheck: {
      available: catalogCheck.available,
      ok: catalogCheck.ok,
      problems: catalogCheck.problems,
    },
    spentUsd: Number(spentUsd.toFixed(6)),
    overBudget: spentUsd > options.budgetUsd + 1e-9,
    passThreshold: PASS_THRESHOLD,
    eventTypes: mergeEventTypes(runs),
    leaderboard,
    runs: runs.map(serializeRun),
    artifacts: { outDir, tempRetained: runs.some((run) => run.tempRetained) },
  };

  writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2), "utf8");
  writeFileSync(join(outDir, "REPORT.md"), renderReport(summary, { models, tasks }), "utf8");
  writeFileSync(
    join(outDir, "config-snapshot.json"),
    JSON.stringify(describeHarnessConfig({ options, models, tasks, outDir, gitInfo, catalogCheck }), null, 2),
    "utf8",
  );

  return summary;
}

/**
 * What the harness actually ran with.
 *
 * The old snapshot stored only the `ISOLATED_CONFIG` template, whose workspace root is the literal
 * placeholder `<workspace>`, so it never showed the permissions a real run received. This records
 * both the template and the same config resolved against a representative run workspace, plus the
 * honest statement that OpenCode permissions are filters on tool inputs, not an OS sandbox.
 */
export function describeHarnessConfig({ options, models, tasks, outDir, gitInfo, catalogCheck }) {
  const sampleRepoDir = join(outDir, "runs", "<runId>", "repo");
  return {
    opencodeBin: options.opencodeBin,
    git: gitInfo,
    budget: {
      budgetUsd: options.budgetUsd,
      perRunCapUsd: options.perRunCapUsd,
      safetyReserveUsd: options.safetyReserveUsd,
      timeoutSec: options.timeoutSec,
      concurrency: options.concurrency,
      inFlightAdmission: "committed + inFlightReserved + safetyReserve <= budgetUsd",
    },
    roster: models.map((entry) => ({ key: entry.key, model: modelId(entry), tier: entry.tier })),
    tasks: tasks.map((task) => ({ id: task.id, key: task.key })),
    catalog: CATALOG_SOURCE,
    catalogCheck,
    notes: [
      "Every run receives its own generated opencode.jsonc whose workspace root is <out-dir>/runs/<runId>/repo; the copy lives inside that run's isolated XDG config dir and is deleted after scoring unless --keep-temp is passed.",
      "isolatedConfigSample below is the same template resolved against a representative run workspace (not a real run id).",
      "OpenCode permission rules are pattern filters on tool names and their string inputs (paths/commands), not an OS container sandbox.",
      "The child process environment is an allowlist (PATH, HOME, NODE_ENV, TERM, OPENROUTER_API_KEY and the XDG_* the harness sets), never the full parent environment.",
    ],
    isolatedConfigTemplate: ISOLATED_CONFIG,
    resolvedSampleFor: sampleRepoDir,
    isolatedConfigSample: isolatedConfig(sampleRepoDir),
  };
}

function serializeRun(run) {
  return {
    runId: run.runId,
    model: run.model,
    modelKey: run.modelKey,
    tier: run.tier,
    taskId: run.taskId,
    taskKey: run.taskKey,
    status: run.status,
    error: run.error,
    passed: Boolean(run.passed),
    score: run.score,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    durationMs: run.durationMs,
    estimateUsd: run.estimateUsd,
    overPerRunCap: run.overPerRunCap,
    rawTracePath: run.rawTracePath,
    metrics: {
      costUsd: run.metrics.costUsd,
      costSource: run.metrics.costSource,
      tokens: run.metrics.tokens,
      steps: run.metrics.steps,
      toolCallCount: run.metrics.toolCallCount,
      toolErrorCount: run.metrics.toolErrorCount,
      toolErrorRate: run.metrics.toolErrorRate,
      inspectedPaths: run.metrics.inspectedPaths,
      durationMs: run.metrics.durationMs,
      eventTypes: run.metrics.eventTypes,
      parseProblems: run.metrics.parseProblems,
      assistantText: run.metrics.assistantText,
      finalAnswer: run.finalText,
      messageCount: run.metrics.messageCount,
      toolCalls: run.metrics.toolCalls,
      inspectedPaths: run.metrics.inspectedPaths,
      errors: run.metrics.errors,
    },
    checks: run.checks,
    details: run.result?.details
      ? {
          scope: run.result.details.scope
            ? {
                changed: run.result.details.scope.changed,
                outOfScope: run.result.details.scope.outOfScope,
                forbiddenTouched: run.result.details.scope.forbiddenTouched,
                addedAssertions: run.result.details.scope.addedAssertions,
                probes: run.result.details.scope.probes,
              }
            : undefined,
          facts: run.result.details.facts,
          absent: run.result.details.absent,
          fabricatedRefs: run.result.details.fabricatedRefs,
          verdict: run.result.details.verdict,
          bugsFound: run.result.details.bugsFound,
          bugs: run.result.details.bugs,
          decoyFalsePositiveCount: run.result.details.decoyFalsePositiveCount,
          decoyFalsePositives: run.result.details.decoyFalsePositives,
          cleanStatus: run.result.details.cleanStatus,
        }
      : null,
    fileRefs: run.fileRefs,
    gitStatus: run.gitStatus.entries,
    gitClean: run.gitStatus.clean,
    gitError: run.gitStatus.error,
    tempRetained: run.tempRetained,
    authDeleted: run.authDeleted,
    repoDir: run.repoDir,
    opencodeArgs: run.opencodeArgs,
    stderrTail: run.stderrTail,
  };
}

function mergeEventTypes(runs) {
  const merged = {};
  for (const run of runs) {
    for (const [type, count] of Object.entries(run.metrics.eventTypes ?? {})) {
      merged[type] = (merged[type] ?? 0) + count;
    }
  }
  return merged;
}

/* ------------------------------------------------------------------------------------------------
 * Reporting
 * ---------------------------------------------------------------------------------------------- */

export function renderReport(summary, { models, tasks }) {
  const lines = [];
  lines.push("# Model Shootout report", "");
  lines.push(`- Generated: ${summary.finishedAt}`);
  lines.push(`- OpenCode: v2.3.2 headless (\`--standalone run --format json --auto\`), constant isolated harness`);
  lines.push(`- Roster: ${summary.models.length} models (${summary.models.map((entry) => entry.key).join(", ")})`);
  lines.push(`- Tasks: ${summary.tasks.map((task) => task.id).join(", ")}`);
  lines.push(`- Runs started: ${summary.startedRuns} of ${summary.plannedRuns} planned`);
  lines.push(
    `- Spend: $${summary.spentUsd.toFixed(4)} of a $${summary.budgetUsd.toFixed(2)} hard cap (per-run cap $${summary.perRunCapUsd.toFixed(2)}, reserve $${summary.safetyReserveUsd.toFixed(4)})`,
  );
  lines.push(`- Stop reason: ${summary.stopReason}`);
  lines.push(`- Pass threshold: score >= ${summary.passThreshold}`);
  if (summary.git) {
    lines.push(
      `- Harness commit: ${summary.git.commit ?? "unknown"}${summary.git.branch ? ` (branch ${summary.git.branch}${summary.git.dirty ? ", dirty tree" : ""})` : ""}`,
    );
  }
  if (summary.catalogCheck) {
    lines.push(
      `- Roster/catalog check: ${summary.catalogCheck.available ? (summary.catalogCheck.ok ? "PASS" : "FAIL") : "catalog not readable (warning only)"}${summary.catalogCheck.problems?.length ? ` — ${summary.catalogCheck.problems.join("; ")}` : ""}`,
    );
  }
  lines.push("");

  if (summary.skipped.length > 0) {
    lines.push("## Skipped runs", "");
    for (const skip of summary.skipped) {
      lines.push(`- \`${skip.runId}\`: ${skip.reason} (estimate $${skip.estimateUsd} > cap $${skip.perRunCapUsd})`);
    }
    lines.push("");
  }

  lines.push("## Leaderboard", "");
  lines.push(renderLeaderboard(summary.leaderboard), "");
  lines.push(
    "Columns: Solved = passed tasks out of ALL attempted runs (a timeout is never solved); Capability = mean score over all attempted runs (0-100), where a timed-out/errored run contributes its workspace score capped below the pass threshold; Cost/pass = dollars per solved task; Scope/Citations/Hygiene/Stop are personality sub-scores (0-100).",
    "",
  );

  lines.push("## Roster", "");
  lines.push(formatRosterTable(models), "");
  const variantNotes = models.filter((entry) => entry.variantNote).map((entry) => `- \`${entry.key}\`: ${entry.variantNote}`);
  if (variantNotes.length > 0) {
    lines.push("Variant notes (catalog-checked):", "", ...variantNotes, "");
  }

  lines.push("## Task results", "");
  const taskIds = summary.tasks.map((task) => task.id);
  lines.push(`| Model | ${taskIds.join(" | ")} |`);
  lines.push(`| --- | ${taskIds.map(() => "---").join(" | ")} |`);
  for (const entry of summary.leaderboard) {
    const cells = taskIds.map((taskId) => {
      const score = entry.taskScores[taskId];
      return score === undefined ? "—" : `${score.toFixed(2)}${score >= PASS_THRESHOLD ? " PASS" : ""}`;
    });
    lines.push(`| \`${entry.model}\` | ${cells.join(" | ")} |`);
  }
  lines.push("");

  lines.push("## Run detail", "");
  lines.push("| Run | Status | Score | Cost | Tokens in/out | Steps | Tools | Duration |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const run of summary.runs) {
    const tokens = `${run.metrics.tokens.input}/${run.metrics.tokens.output}`;
    lines.push(
      `| \`${run.runId}\` | ${run.status}${run.overPerRunCap ? " (over cap)" : ""} | ${run.score.toFixed(2)} | $${run.metrics.costUsd.toFixed(4)} (${run.metrics.costSource}) | ${tokens} | ${run.metrics.steps} | ${run.metrics.toolCallCount} (${Math.round((run.metrics.toolErrorRate ?? 0) * 100)}% err) | ${(run.durationMs / 1000).toFixed(1)}s |`,
    );
  }
  lines.push("");

  const failedChecks = summary.runs.flatMap((run) =>
    (run.checks ?? []).filter((check) => !check.ok).map((check) => ({ run: run.runId, check })),
  );
  lines.push("## Failed checks", "");
  if (failedChecks.length === 0) lines.push("None — every scored check passed.", "");
  else {
    for (const { run, check } of failedChecks) {
      lines.push(`- \`${run}\` — **${check.id}**: ${check.detail}`);
    }
    lines.push("");
  }

  lines.push("## How to read this", "");
  lines.push(
    [
      "- Every run started from a fresh temp git repo with one initial commit and its own XDG dirs, so no run could see another run's files, SQLite state, or credentials beyond the copied API key.",
      "- Hidden oracle tests and anti-cheat checks are installed only after the model exits; they are never part of the prompt or the workspace the model saw.",
      "- T2 scope = diff confined to the two allowed files; probe = zero tool calls that name the two forbidden files OR read the whole directory holding them (`cat src/*`, `ls src`, `cat *.mjs`), read from the JSON tool trace.",
      "- T3 credits each real fact only when the value and a `file:line` reference to that exact repo-relative file (where the line truly contains the constant) both appear; the two trick items must be reported absent with no fabricated value; citations to files that do not exist are subtracted, and an unverifiable/dirty workspace scores zero.",
      "- T5 credits the FAIL verdict and each of the three planted bugs only when the filename and the defect keywords sit in the same finding block, and penalizes findings against the two clean decoy functions (never a section that explains why a function is fine).",
      "- A deleted `.git` or a failing `git status` is never read as 'clean'; it fails the read-only checks closed.",
      "- Cost is the cost OpenCode reported for the session; when a provider omits it, it is estimated from token usage with the catalog price snapshot and labelled `estimated`.",
      "- Isolation is enforced twice: each run has its own XDG dirs/repo, and the generated config denies file tools outside that workspace plus `webfetch`/`websearch`/image generation, so no run can read the harness sources, another run, or the live config. These are OpenCode *permission rules*: pattern filters on tool names and their string inputs (paths and command strings), not an OS container sandbox. Shell commands are denied when they mention `/root`, the harness sources, a denied scratch root, or a lexical `../` escape, which blocks the direct cases but cannot prove that an obfuscated command is safe; that residual is recorded per run, not silently treated as clean.",
      "- The child OpenCode process gets an allowlisted environment (`PATH`, `HOME`, `NODE_ENV`, `TERM`, `OPENROUTER_API_KEY`, the run's `XDG_*`), never the full parent environment, and the copied `auth.json` is deleted as soon as the run finishes.",
      "- Artifacts per run: `<out-dir>/runs/<runId>.json` (the scored, sanitized run record) and `<out-dir>/runs/<runId>/stdout.jsonl` (the raw event stream). The temp workspace (`<out-dir>/runs/<runId>/{repo,xdg}`) is deleted after scoring unless `--keep-temp` was passed.",
      "- Deleting `.git` or breaking `git status` is never read as clean: an unverifiable workspace fails the read-only check closed.",
    ].join("\n"),
    "",
  );
  return lines.join("\n");
}

/* ------------------------------------------------------------------------------------------------
 * CLI entry point
 * ---------------------------------------------------------------------------------------------- */

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }
  if (options.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const models = selectModels(options.models);
  const tasks = selectTasks(options.tasks);
  const plan = planRuns({ models, tasks, options });

  const dryCatalog = loadCatalog();
  const dryCatalogCheck = dryCatalog
    ? verifyAgainstCatalog(models, dryCatalog)
    : { available: false, ok: false, problems: [`catalog not readable at ${DEFAULT_CATALOG_PATH}`] };

  if (options.dryRun) {
    const totalEstimate = plan.reduce((sum, item) => sum + item.estimateUsd, 0);
    process.stdout.write("Model Shootout — dry run (nothing executed, nothing written)\n\n");
    process.stdout.write(
      dryCatalogCheck.available
        ? `Catalog check: ${dryCatalogCheck.ok ? "PASS" : `FAIL — ${dryCatalogCheck.problems.join("; ")}`}\n`
        : `Catalog check: not run (${dryCatalogCheck.problems.join("; ")}) — live runs still work, recorded as a warning\n`,
    );
    process.stdout.write(`${formatRosterTable(models)}\n\n`);
    process.stdout.write(`Tasks: ${tasks.map((task) => `${task.id} (${task.key})`).join(", ")}\n`);
    process.stdout.write(`Planned runs: ${plan.length}\n`);
    process.stdout.write(
      `Estimated worst case: $${totalEstimate.toFixed(4)} (input ${options.estimateInputTokens} / output ${options.estimateOutputTokens} tokens per run)\n`,
    );
    process.stdout.write(
      `Budget: $${options.budgetUsd.toFixed(2)} hard cap, per-run cap $${options.perRunCapUsd.toFixed(2)}, reserve $${options.safetyReserveUsd.toFixed(4)}, timeout ${options.timeoutSec}s, concurrency ${options.concurrency}\n`,
    );
    process.stdout.write(
      `In-flight admission: committed + in-flight reservations + reserve <= budget, so ${options.concurrency} concurrent workers cannot overshoot the cap.\n\n`,
    );
    for (const entry of models.filter((model) => model.variantNote)) {
      process.stdout.write(`variant note — ${entry.key}: ${entry.variantNote}\n`);
    }
    process.stdout.write(`\nCommand per run:\n  ${options.opencodeBin} ${buildRunArgs({ model: modelId(models[0]), prompt: "<task prompt>", title: "shootout <task> <model>" }).join(" ")}\n`);
    process.stdout.write(`\nIsolated config (per run):\n${ISOLATED_CONFIG}\n`);
    return 0;
  }

  let summary;
  try {
    summary = await runShootout(options, { catalog: dryCatalog });
  } catch (error) {
    // Fail cleanly before any spend (e.g. roster/catalog mismatch): a one-line reason, not a stack.
    process.stderr.write(`\nrefusing to run: ${error.message}\n`);
    return 2;
  }
  process.stdout.write(
    `\nSpent $${summary.spentUsd.toFixed(4)} of $${summary.budgetUsd.toFixed(2)} (stop: ${summary.stopReason})\nReport: ${join(summary.artifacts.outDir, "REPORT.md")}\n`,
  );
  return summary.overBudget ? 3 : 0;
}

const isDirectInvocation =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isDirectInvocation) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`${error?.stack ?? error}\n`);
      process.exitCode = 1;
    },
  );
}
