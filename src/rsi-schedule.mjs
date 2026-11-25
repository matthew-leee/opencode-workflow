// Wave 2 Layer 2 — Weekly Read-Only RSI Schedule Helper for OpenCode's native `automation` tool.
//
// Builds a zero-LLM ($0.00), strictly read-only weekly cron automation specification that runs
// `src/rsi-prune.mjs` and writes its report to `~/.local/share/opencode-workflow/rsi-latest.txt`
// (never touching `config/`, `~/.config/opencode`, `/root/.pi`, or `pi-workflow-tools`).

import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveSafeReportPath } from "./rsi-prune.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const WEEKLY_RSI_AUTOMATION_NAME = "Weekly Read-Only RSI Review";
export const WEEKLY_RSI_CRON = "0 9 * * 1"; // Every Monday at 09:00
export const DEFAULT_RSI_TZ = "UTC";

/**
 * Quote one value for safe POSIX shell word use with `'...'` single quotes.
 *
 * Single quotes disable every expansion (`$VAR`, `$(...)`, backticks and globs); an embedded
 * single quote is emitted as the canonical `'\''` sequence. Empty strings and ASCII control
 * characters (including newlines) are rejected outright: they cannot be represented safely in
 * a cron shell command line.
 */
export function shellQuotePosix(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("shellQuotePosix requires a non-empty string");
  }
  if (/[\x00-\x1f\x7f]/.test(value)) {
    throw new Error("shellQuotePosix refuses control characters (including newlines)");
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Build the canonical OpenCode native `automation.create` payload for the weekly RSI review. */
export function buildWeeklyRsiAutomationSpec({
  repoRoot = REPO_ROOT,
  outPath = join(homedir(), ".local", "share", "opencode-workflow", "rsi-latest.txt"),
  days = 7,
  cron = WEEKLY_RSI_CRON,
  tz = DEFAULT_RSI_TZ,
  name = WEEKLY_RSI_AUTOMATION_NAME,
} = {}) {
  const safeDays = Number.isFinite(Number(days)) && Number(days) > 0 ? Math.floor(Number(days)) : 7;
  const resolvedRepoRoot = resolve(repoRoot);
  const scriptPath = resolve(join(resolvedRepoRoot, "src", "rsi-prune.mjs"));
  // Validate the report target at build time, not only when the cron job eventually runs.
  const resolvedOut = resolveSafeReportPath(outPath, { repoRoot: resolvedRepoRoot });

  return {
    name,
    trigger: {
      type: "cron",
      cron,
      tz,
    },
    action: {
      type: "shell",
      // Read-only report: zero LLM calls ($0.00), never mutates config/ or AGENTS.md.
      command: `node ${shellQuotePosix(scriptPath)} --days ${safeDays} --out ${shellQuotePosix(resolvedOut)}`,
    },
  };
}

/**
 * Idempotently ensure the weekly read-only RSI schedule is registered with OpenCode's native
 * `automation` API (`{ list, create }`). Returns `{ created, automation }`.
 */
export async function ensureWeeklyRsiAutomation(automationApi, options = {}) {
  if (!automationApi || typeof automationApi.list !== "function" || typeof automationApi.create !== "function") {
    throw new Error("automationApi must expose list() and create()");
  }
  const spec = buildWeeklyRsiAutomationSpec(options);
  const listed = await automationApi.list();
  const items = Array.isArray(listed) ? listed : Array.isArray(listed?.automations) ? listed.automations : [];
  const existing = items.find(
    (item) => item && item.name === spec.name && item.status !== "done",
  );
  if (existing) {
    return { created: false, automation: existing, spec };
  }
  const created = await automationApi.create(spec);
  return { created: true, automation: created, spec };
}
