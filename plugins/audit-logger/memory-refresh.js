/**
 * Wave 2 Layer 2 — Automatic bounded project `MEMORY.md` refresh on `experimental.idle`.
 *
 * After meaningful work in a real project workspace (never on child subagents, never on
 * ephemeral OpenChamber ad-hoc chat directories, never inside `/root/.pi` or
 * `/root/pi-projects/pi-workflow-tools`), asynchronously consolidates `MEMORY.md`
 * (hard-capped <= 2,500 chars, atomic write with `.bak` backup) using the fast cheap
 * model via `ctx.experimental.generate.text` (or `OPENROUTER_API_KEY` if available).
 *
 * Non-blocking and cooldown-gated so interactive chats stay snappy and cost stays negligible.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_MEMORY_MODEL,
  HARD_MEMORY_LIMIT,
  consolidateMemory,
} from '../../src/memory-consolidate.mjs';
import { assertNotTerra } from './reactive-guard.js';
import { redactString } from './redact.js';

export const DEFAULT_MEMORY_REFRESH_CONFIG = Object.freeze({
  enabled: true,
  minToolCalls: 4,
  minFileMutations: 1,
  cooldownMs: 10 * 60_000, // 10 minutes per workspace
  maxChars: HARD_MEMORY_LIMIT,
  model: DEFAULT_MEMORY_MODEL, // deepseek/deepseek-v4.1-flash-1017
  timeoutMs: 25_000,
});

const FORBIDDEN_PREFIXES = Object.freeze([
  '/root/.pi',
  '/root/pi-projects/pi-workflow-tools',
  // OpenCode's live config directory must never receive an unattended MEMORY.md write.
  path.join(os.homedir(), '.config', 'opencode'),
  '/root/.config/opencode',
]);

const EPHEMERAL_CHAT_RE = /\/\.config\/openchamber\/chats(?:\/|$)/i;

/** True only when `directory` is a real, safe project workspace eligible for `MEMORY.md`. */
export function isEligibleMemoryWorkspace(directory) {
  if (typeof directory !== 'string' || directory.trim().length === 0) return false;
  let resolved;
  try {
    resolved = path.resolve(directory.trim());
  } catch {
    return false;
  }
  if (resolved === '/' || resolved === path.parse(resolved).root) return false;
  if (EPHEMERAL_CHAT_RE.test(resolved.replace(/\\/g, '/'))) return false;

  for (const forbidden of FORBIDDEN_PREFIXES) {
    if (resolved === forbidden || resolved.startsWith(`${forbidden}${path.sep}`)) return false;
  }

  let real = resolved;
  try {
    real = fs.realpathSync(resolved);
  } catch {
    return false;
  }
  // Check the canonical path too, so a symlink into an ephemeral chat dir is still rejected.
  if (EPHEMERAL_CHAT_RE.test(real.replace(/\\/g, '/'))) return false;
  for (const forbidden of FORBIDDEN_PREFIXES) {
    if (real === forbidden || real.startsWith(`${forbidden}${path.sep}`)) return false;
  }

  // Must look like a real project directory (git repo, existing MEMORY.md, PLAN.md, or manifest)
  const markers = ['.git', 'MEMORY.md', 'PLAN.md', 'package.json', 'Cargo.toml', 'pyproject.toml', 'go.mod'];
  return markers.some((m) => fs.existsSync(path.join(real, m)));
}

/** Build a `consolidateMemory`-compatible `llm` adapter backed by `ctx.experimental.generate.text`. */
export function makePluginTextLlm(ctx, modelId, timeoutMs) {
  // Refuse a banned model before building or calling any adapter.
  assertNotTerra(modelId);
  if (typeof ctx?.experimental?.generate?.text !== 'function') return null;
  const slash = modelId.indexOf('/');
  const model = slash > 0 && !modelId.startsWith('openrouter/')
    ? { providerID: 'openrouter', id: modelId }
    : modelId.startsWith('openrouter/')
      ? { providerID: 'openrouter', id: modelId.slice('openrouter/'.length) }
      : { providerID: 'openrouter', id: modelId };

  return async function pluginLlm(request) {
    const messages = Array.isArray(request?.messages) ? request.messages : [];
    const prompt = messages
      .map((m) => `${String(m.role || 'user').toUpperCase()}:\n${String(m.content || '')}`)
      .join('\n\n');
    let timer = null;
    try {
      const res = await Promise.race([
        ctx.experimental.generate.text({ prompt, model }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('memory refresh model timed out')), timeoutMs);
          if (typeof timer.unref === 'function') timer.unref();
        }),
      ]);
      return typeof res === 'string' ? res : res?.text ?? '';
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

export function createMemoryRefresher(options = {}) {
  const envDisabled = String(options.env?.OPENCODE_WORKFLOW_MEMORY_REFRESH ?? process.env.OPENCODE_WORKFLOW_MEMORY_REFRESH ?? '')
    .trim()
    .toLowerCase();
  const config = {
    ...DEFAULT_MEMORY_REFRESH_CONFIG,
    enabled: !(envDisabled === '0' || envDisabled === 'false' || envDisabled === 'off'),
    ...(options.config ?? {}),
  };
  assertNotTerra(config.model);
  const clock = typeof options.clock === 'function' ? options.clock : () => Date.now();
  const record = typeof options.record === 'function' ? options.record : () => {};
  const auditDir = options.auditDir ?? null;
  const dbPath = options.dbPath;
  const customLlm = options.llm ?? null;

  /** @type {Map<string, number>} workspace -> last refresh epoch ms */
  const lastRefreshAt = new Map();
  /** @type {Set<string>} workspaces currently running a refresh */
  const inFlight = new Set();

  /**
   * Decide whether a root session going idle should trigger a `MEMORY.md` refresh,
   * and run it safely if eligible.
   */
  async function maybeRefreshOnIdle({ sessionID, isChild, directory, toolCalls = 0, fileMutations = 0, ctx }) {
    if (!config.enabled) return { refreshed: false, reason: 'disabled' };
    if (isChild) return { refreshed: false, reason: 'child_session' };
    if (!isEligibleMemoryWorkspace(directory)) return { refreshed: false, reason: 'ineligible_workspace' };

    const meaningful = toolCalls >= config.minToolCalls || fileMutations >= config.minFileMutations;
    if (!meaningful) return { refreshed: false, reason: 'below_meaningful_work_threshold' };

    const workspace = path.resolve(directory);
    const now = clock();
    const prev = lastRefreshAt.get(workspace) ?? 0;
    if (prev > 0 && now - prev < config.cooldownMs) {
      return { refreshed: false, reason: 'cooldown' };
    }
    if (inFlight.has(workspace)) {
      return { refreshed: false, reason: 'in_flight' };
    }

    const llm = customLlm
      ?? makePluginTextLlm(ctx, config.model, config.timeoutMs)
      ?? null;
    const hasEnvKey = Boolean(process.env.OPENROUTER_API_KEY);
    if (!llm && !hasEnvKey) {
      return { refreshed: false, reason: 'no_model_available' };
    }

    inFlight.add(workspace);
    try {
      const res = await consolidateMemory({
        workspace,
        auditDirs: auditDir ? [auditDir] : [],
        dbPath,
        maxChars: config.maxChars,
        model: config.model,
        llm: llm ?? undefined,
        now,
      });
      lastRefreshAt.set(workspace, now);
      record('memory.refresh.completed', {
        sessionID,
        workspace,
        memoryPath: res.memoryPath,
        characters: res.characters,
        status: res.status,
        written: res.written,
      });
      return { refreshed: true, result: res };
    } catch (error) {
      const msg = redactString(String(error?.message ?? error), { maxLength: 300 });
      // Cooldown failed attempts too, so a failing model is not retried on every idle.
      lastRefreshAt.set(workspace, now);
      record('memory.refresh.failed', {
        sessionID,
        workspace,
        message: msg,
      });
      return { refreshed: false, reason: 'error', error: msg };
    } finally {
      inFlight.delete(workspace);
    }
  }

  return {
    config,
    maybeRefreshOnIdle,
    get inFlightCount() {
      return inFlight.size;
    },
  };
}
