/**
 * Wave 2 — Always-On Reactive Security Guard (Layer 0 + Layer 1 + Action Executor).
 *
 * Replaces manual-only CLI supervision (`npm run supervise`) with an in-process plugin
 * guard that monitors every live OpenChamber root session and child subagent:
 *
 *   Layer 0 ($0.00, pure local state):
 *     - Repeated identical errors (default 3x)
 *     - Worker/session spin (~16 steps with no file progress, or oscillating file edits)
 *     - Single-turn prompt context bloat (~135k tokens, computed from usage deltas)
 *     - Cumulative spend checkpoints ($4 increments) and hard chain spend fuse ($15)
 *     - 2+ reviewer / alt-reviewer rejections on the same root session chain
 *     -> ZERO LLM calls while healthy.
 *
 *   Layer 1 (cheap System-1 judge, ONLY on tripwire):
 *     1. OpenCode native `ctx.experimental.generate.decisions` (when decision model configured)
 *     2. OpenRouter `/api/v1/systemone` (`~perplexity/pplx-decider-latest` / `baseten/bison-1`)
 *     3. Fast chat fallback via `ctx.experimental.generate.text` or OpenRouter chat
 *        (`openai/gpt-6-luna`, fallback `deepseek/deepseek-v4.1-flash-1017`)
 *     4. Deterministic fail-safe fallback if all remote judges are unavailable/malformed.
 *     GPT-6.1 Terra is strictly banned and refused in every code path.
 *
 *   Full 6-action intervention set:
 *     - `continue`         (stay quiet)
 *     - `steer`            (`ctx.session.synthetic` with `delivery: "steer", resume: true`)
 *     - `interrupt_worker` (`ctx.session.interrupt` stuck child + concise report to parent)
 *     - `compact`          (`ctx.session.compact` for healthy mid-task bloat ~120k-150k)
 *     - `rotate_session`   (`ctx.session.interrupt` old + `ctx.session.create` + `ctx.session.prompt`
 *                           preserving goal, bounded MEMORY.md, git status, Blackboard pointer,
 *                           max-2 chain cap, shared cumulative spend fuse, and visible handoff
 *                           pointer written to the old OpenChamber chat with `resume: false`)
 *     - `hard_stop`        (`ctx.session.interrupt` + visible human-blocker alert with `resume: false`)
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { extractJsonObject, redactSecrets } from '../../src/openrouter-client.mjs';
import { HARD_MEMORY_LIMIT, readMemoryContext } from '../../src/memory-consolidate.mjs';
import { collectWorkspaceFallbackState } from './blackboard.js';
import { redactString } from './redact.js';

export const GUARD_ACTIONS = Object.freeze([
  'continue',
  'steer',
  'interrupt_worker',
  'compact',
  'rotate_session',
  'hard_stop',
]);

export const DEFAULT_SYSTEMONE_ENDPOINT = 'https://openrouter.ai/api/v1/systemone';
export const DEFAULT_SYSTEMONE_MODEL = '~perplexity/pplx-decider-latest';
export const DEFAULT_FALLBACK_CHAT_MODELS = Object.freeze([
  { providerID: 'openrouter', id: 'openai/gpt-6-luna' },
  { providerID: 'openrouter', id: 'deepseek/deepseek-v4.1-flash-1017' },
]);

export const DEFAULT_GUARD_CONFIG = Object.freeze({
  enabled: true,
  identicalErrorThreshold: 3,
  workerSpinSteps: 16,
  oscillationWindow: 8,
  contextBloatTokens: 135_000,
  contextBloatHardRotateCompactions: 2,
  spendCheckpointUsd: 4.0,
  chainSpendFuseUsd: 15.0,
  maxRotationChain: 2,
  reviewerRejectionThreshold: 2,
  judgeCooldownMs: 30_000,
  judgeTimeoutMs: 10_000,
  maxTrackedSessions: 2_000,
  decisionModel: null, // e.g. { providerID: 'baseten', id: 'baseten/bison-1' } when configured
  systemOneEndpoint: DEFAULT_SYSTEMONE_ENDPOINT,
  systemOneModel: DEFAULT_SYSTEMONE_MODEL,
  systemOneEnabled: true,
  fallbackChatModels: DEFAULT_FALLBACK_CHAT_MODELS,
});

// Wave 2 shared Terra ban: any model identifier containing "terra" is refused (matches the
// RSI audit's `/terra/i` check in `src/rsi-prune.mjs`). Variants like `gpt-6-1-terra`,
// `gpt-6.1_terra`, `gpt-6.1 terra` and bare `openai/terra` are all covered.
const TERRA_RE = /terra/i;
const FILE_MUTATION_TOOLS = new Set(['edit', 'write', 'patch', 'apply_patch']);
const VERIFY_SHELL_RE = /\b(?:npm\s+test|pnpm\s+test|yarn\s+test|cargo\s+test|pytest|go\s+test|vitest|jest|node\s+--test|tsc\b|cargo\s+check|cargo\s+build|npm\s+run\s+build)\b/i;
const REVIEWER_AGENTS = new Set(['reviewer', 'alt-reviewer']);

// A FAIL verdict is explicit ("VERDICT: FAIL", "Verdict: **FAIL**") or a positive blocking count
// ("3 blocking findings", "2 blocking issues", "Blocking findings: 3"). A PASS report that merely
// contains a heading such as "## Fail-open analysis" or says "Blocking findings: none" must NOT
// be treated as a rejection.
const REVIEWER_FAIL_VERDICT_RE = /verdict\s*[:\-]\s*\*{0,2}\s*fail\b/i;
const REVIEWER_BLOCKING_RE = /\b[1-9]\d*\s+blocking\s+(?:findings?|issues?|defects?)\b|\bblocking\s+(?:findings?|issues?|defects?)\s*[:\-]\s*(?:[1-9]\d*|yes)\b/i;
const REVIEWER_FAIL_RE = new RegExp(`(?:${REVIEWER_FAIL_VERDICT_RE.source}|${REVIEWER_BLOCKING_RE.source})`, 'i');
const REVIEWER_PASS_RE = /(?:verdict\s*[:\-]\s*\*{0,2}\s*pass\b|\bno\s+blockers?\b|\b0\s+blockers?\b|\b(?:0|zero)\s+blocking\b|\bblocking\s+(?:findings?|issues?|defects?)\s*[:\-]\s*(?:none|0|zero)\b)/i;

function collectModelStrings(model, depth = 0) {
  if (depth > 2) return [];
  if (typeof model === 'string') return [model];
  if (!model || typeof model !== 'object') return [];
  const values = [];
  for (const key of ['providerID', 'id', 'model', 'name']) {
    let value;
    try {
      value = model[key];
    } catch {
      value = undefined;
    }
    if (typeof value === 'string') values.push(value);
    else if (value && typeof value === 'object') values.push(...collectModelStrings(value, depth + 1));
  }
  return values;
}

/** True when a model reference (string or object) names the banned GPT-6.1 Terra family. */
export function isBannedModel(model) {
  return collectModelStrings(model).some((value) => TERRA_RE.test(value));
}

/** Throw when a model reference names the banned GPT-6.1 Terra family. */
export function assertNotTerra(model) {
  if (!isBannedModel(model)) return;
  const rendered = collectModelStrings(model).join(' ');
  throw new Error(`Refusing banned GPT-6.1 Terra model in reactive guard: ${rendered}`);
}

export function parseModelRef(raw) {
  if (!raw) return null;
  if (typeof raw === 'object' && typeof raw.id === 'string' && typeof raw.providerID === 'string') {
    assertNotTerra(raw);
    return {
      providerID: raw.providerID.trim(),
      id: raw.id.trim(),
      ...(typeof raw.variant === 'string' && raw.variant.trim() ? { variant: raw.variant.trim() } : {}),
    };
  }
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  assertNotTerra(trimmed);
  const hashIdx = trimmed.indexOf('#');
  const main = hashIdx >= 0 ? trimmed.slice(0, hashIdx) : trimmed;
  const variant = hashIdx >= 0 ? trimmed.slice(hashIdx + 1).trim() : '';
  const slashIdx = main.indexOf('/');
  if (slashIdx <= 0) return null;
  return {
    providerID: main.slice(0, slashIdx),
    id: main.slice(slashIdx + 1),
    ...(variant ? { variant } : {}),
  };
}

function readNumEnv(env, key, fallback, min = 0) {
  const raw = env?.[key];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > min ? n : fallback;
}

export function resolveGuardConfig(overrides = {}, env = process.env) {
  const disabledEnv = String(env?.OPENCODE_WORKFLOW_GUARD_ENABLED ?? '').trim().toLowerCase();
  const enabledByEnv = !(disabledEnv === '0' || disabledEnv === 'false' || disabledEnv === 'off');

  const envDecision = env?.OPENCODE_WORKFLOW_DECISION_MODEL
    ? parseModelRef(env.OPENCODE_WORKFLOW_DECISION_MODEL)
    : null;
  const systemOneModel = String(env?.OPENCODE_WORKFLOW_SYSTEMONE_MODEL ?? overrides.systemOneModel ?? DEFAULT_SYSTEMONE_MODEL).trim();
  assertNotTerra(systemOneModel);

  const fallbackChatModels = Array.isArray(overrides.fallbackChatModels)
    ? overrides.fallbackChatModels.map((m) => parseModelRef(m)).filter(Boolean)
    : DEFAULT_FALLBACK_CHAT_MODELS;
  for (const m of fallbackChatModels) assertNotTerra(m);

  const decisionModel = overrides.decisionModel !== undefined
    ? parseModelRef(overrides.decisionModel)
    : envDecision;

  return {
    ...DEFAULT_GUARD_CONFIG,
    enabled: enabledByEnv,
    identicalErrorThreshold: Math.floor(readNumEnv(env, 'OPENCODE_WORKFLOW_GUARD_ERROR_THRESHOLD', DEFAULT_GUARD_CONFIG.identicalErrorThreshold, 0)),
    workerSpinSteps: Math.floor(readNumEnv(env, 'OPENCODE_WORKFLOW_GUARD_SPIN_STEPS', DEFAULT_GUARD_CONFIG.workerSpinSteps, 0)),
    contextBloatTokens: Math.floor(readNumEnv(env, 'OPENCODE_WORKFLOW_GUARD_CONTEXT_TOKENS', DEFAULT_GUARD_CONFIG.contextBloatTokens, 0)),
    spendCheckpointUsd: readNumEnv(env, 'OPENCODE_WORKFLOW_GUARD_SPEND_CHECKPOINT', DEFAULT_GUARD_CONFIG.spendCheckpointUsd, 0),
    chainSpendFuseUsd: readNumEnv(env, 'OPENCODE_WORKFLOW_GUARD_SPEND_FUSE', DEFAULT_GUARD_CONFIG.chainSpendFuseUsd, 0),
    maxRotationChain: Math.floor(readNumEnv(env, 'OPENCODE_WORKFLOW_GUARD_MAX_ROTATIONS', DEFAULT_GUARD_CONFIG.maxRotationChain, -1)),
    reviewerRejectionThreshold: Math.floor(readNumEnv(env, 'OPENCODE_WORKFLOW_GUARD_REVIEWER_REJECTIONS', DEFAULT_GUARD_CONFIG.reviewerRejectionThreshold, 0)),
    judgeCooldownMs: Math.floor(readNumEnv(env, 'OPENCODE_WORKFLOW_GUARD_COOLDOWN_MS', DEFAULT_GUARD_CONFIG.judgeCooldownMs, -1)),
    ...overrides,
    decisionModel,
    systemOneModel,
    fallbackChatModels,
  };
}

/** Normalize an error message so minor timestamps/line numbers collapse for 3x identical detection. */
export function normalizeErrorSignature(tool, errorText) {
  const cleaned = redactString(String(errorText ?? ''), { maxLength: 300 })
    .toLowerCase()
    .replace(/\b\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}(?:\.\d+)?z\b/g, '<ts>')
    .replace(/\b0x[0-9a-f]+\b/g, '<hex>')
    .replace(/\b\d{5,}\b/g, '<num>')
    .replace(/\s+/g, ' ')
    .trim();
  return `${String(tool || 'tool').toLowerCase()}:${cleaned.slice(0, 180)}`;
}

/** Detect whether a reviewer / alt-reviewer report represents a FAIL / blocking rejection. */
export function isReviewerRejectionText(agent, text) {
  if (!REVIEWER_AGENTS.has(String(agent || '').toLowerCase())) return false;
  const value = String(text ?? '');
  if (!value.trim()) return false;
  // Explicit PASS (verdict/pass, 0 blockers, "blocking findings: none") wins unless the report
  // also contains a real FAIL verdict or a positive blocking count.
  if (
    REVIEWER_PASS_RE.test(value) &&
    !REVIEWER_FAIL_VERDICT_RE.test(value) &&
    !REVIEWER_BLOCKING_RE.test(value)
  ) {
    return false;
  }
  return REVIEWER_FAIL_RE.test(value);
}

/**
 * Detect oscillating file edits: e.g. editing the same file with signature A -> B -> A
 * (or repeating an identical failed/reverted edit state >= 2 times) inside the recent window.
 */
export function detectOscillatingEdits(recentEdits) {
  if (!Array.isArray(recentEdits) || recentEdits.length < 3) return null;
  const byFile = new Map();
  for (const item of recentEdits) {
    if (!item?.file || !item?.sig) continue;
    const seq = byFile.get(item.file) ?? [];
    seq.push(item.sig);
    byFile.set(item.file, seq);
  }
  for (const [file, seq] of byFile.entries()) {
    if (seq.length < 3) continue;
    // Check A -> B -> A oscillation (exact revert to an earlier state after an intermediate edit)
    const last = seq[seq.length - 1];
    const prev = seq[seq.length - 2];
    if (last !== prev && seq.slice(0, -2).includes(last)) {
      return { file, pattern: 'A->B->A oscillation', edits: seq.length };
    }
    // Check 3 identical repeated edit payloads on the same file
    if (seq.length >= 3 && seq[seq.length - 1] === seq[seq.length - 2] && seq[seq.length - 2] === seq[seq.length - 3]) {
      return { file, pattern: '3x identical repeated edit', edits: seq.length };
    }
  }
  return null;
}

/** Deterministic fail-safe action when no remote System-1 judge is reachable or output is malformed. */
export function deterministicFallbackDecision(tripwire, state, chain, config) {
  const reason = tripwire.detail || tripwire.kind;
  switch (tripwire.kind) {
    case 'hard_spend_fuse':
      return {
        action: 'hard_stop',
        rationale: `Cumulative chain spend $${chain.totalSpendUsd.toFixed(2)} reached hard fuse $${config.chainSpendFuseUsd.toFixed(2)}.`,
        message: `Hard spend fuse reached ($${chain.totalSpendUsd.toFixed(2)} / $${config.chainSpendFuseUsd.toFixed(2)}). Stopping cleanly for human review.`,
        source: 'deterministic_fuse',
      };
    case 'worker_spin':
      if (state.isChild) {
        return {
          action: 'interrupt_worker',
          rationale: `Child ${state.agent || 'subagent'} spun without progress (${reason}).`,
          message: `Interrupted stuck child ${state.agent || 'subagent'} (${state.sessionID}): ${reason}.`,
          source: 'deterministic_fallback',
        };
      }
      if (state.steerCount >= 2 && chain.rotationCount < config.maxRotationChain) {
        return {
          action: 'rotate_session',
          rationale: `Root session still spinning after ${state.steerCount} steers (${reason}).`,
          message: `Rotating to a fresh session after spin loop (${reason}).`,
          source: 'deterministic_fallback',
        };
      }
      return {
        action: 'steer',
        rationale: `Session spin detected (${reason}); steering for root-cause diagnosis.`,
        message: `Pause and diagnose why no forward progress occurred (${reason}). Summarize the blocker and take a distinct next step instead of repeating.`,
        source: 'deterministic_fallback',
      };
    case 'context_bloat':
      if (state.compactionCount >= config.contextBloatHardRotateCompactions && !state.isChild && chain.rotationCount < config.maxRotationChain) {
        return {
          action: 'rotate_session',
          rationale: `Context reached ${state.latestContextTokens} tokens after ${state.compactionCount} compactions; rotating cleanly.`,
          message: `Context bloat post-compaction #${state.compactionCount} (${state.latestContextTokens} tokens). Rotating session with preserved state.`,
          source: 'deterministic_fallback',
        };
      }
      return {
        action: 'compact',
        rationale: `Single-turn prompt context reached ${state.latestContextTokens} tokens (compactions so far: ${state.compactionCount}).`,
        message: `Compacting context at ${state.latestContextTokens} tokens to prevent latency/cost degradation.`,
        source: 'deterministic_fallback',
      };
    case 'identical_errors':
      if (state.isChild && state.steerCount >= 1) {
        return {
          action: 'interrupt_worker',
          rationale: `Child repeating identical error after prior steer (${reason}).`,
          message: `Interrupted child ${state.agent || 'subagent'} repeating identical error (${reason}).`,
          source: 'deterministic_fallback',
        };
      }
      return {
        action: 'steer',
        rationale: `Repeated identical error (${reason}); steering for diagnosis.`,
        message: `You hit the exact same error ${config.identicalErrorThreshold} times (${reason}). Do NOT retry the same command; inspect the root cause or try a distinct approach.`,
        source: 'deterministic_fallback',
      };
    case 'reviewer_rejections':
      return {
        action: 'steer',
        rationale: `${chain.reviewerRejections} reviewer rejections observed on this task chain.`,
        message: `Reviewer rejected ${chain.reviewerRejections} times with unresolved blockers. Consider escalating to escalate-opus or pausing to clarify requirements rather than repeating another round blindly.`,
        source: 'deterministic_fallback',
      };
    case 'spend_checkpoint':
    default:
      return {
        action: 'continue',
        rationale: `Spend checkpoint ($${chain.totalSpendUsd.toFixed(2)}) reached with no spin/error blocker; continuing.`,
        message: '',
        source: 'deterministic_fallback',
      };
  }
}

/** Enforce hard invariants on any judge decision (no `interrupt_worker` on root, max-2 rotations, etc.). */
export function normalizeGuardDecision(raw, { tripwire, state, chain, config }) {
  const actionRaw = String(raw?.action ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!GUARD_ACTIONS.includes(actionRaw)) {
    return deterministicFallbackDecision(tripwire, state, chain, config);
  }

  let action = actionRaw;
  let rationale = redactString(String(raw?.rationale ?? tripwire.detail ?? action), { maxLength: 300 });
  let message = redactString(String(raw?.message ?? ''), { maxLength: 600 });

  // Hard invariant 1: hard spend fuse ALWAYS stops regardless of judge output.
  if (chain.totalSpendUsd >= config.chainSpendFuseUsd) {
    return deterministicFallbackDecision({ kind: 'hard_spend_fuse', detail: 'chain spend fuse exceeded' }, state, chain, config);
  }

  // Hard invariant 2: `interrupt_worker` only applies to child subagents.
  if (action === 'interrupt_worker' && !state.isChild) {
    action = state.steerCount >= 2 ? 'hard_stop' : 'steer';
    rationale = `${rationale} (root session has no parent; mapped interrupt_worker -> ${action})`;
  }

  // Hard invariant 3: `rotate_session` only applies to root sessions and enforces max-2 chain cap.
  if (action === 'rotate_session') {
    if (state.isChild) {
      action = 'interrupt_worker';
      rationale = `${rationale} (child subagents cannot rotate; mapped -> interrupt_worker)`;
    } else if (chain.rotationCount >= config.maxRotationChain) {
      action = tripwire.kind === 'context_bloat' ? 'compact' : 'hard_stop';
      rationale = `${rationale} (rotation cap ${chain.rotationCount}/${config.maxRotationChain} reached; mapped -> ${action})`;
    }
  }

  // Ensure actionable actions always have a concise default message if the decision model only returned a label.
  if (!message && action !== 'continue') {
    const fb = deterministicFallbackDecision(tripwire, state, chain, config);
    message = fb.message || `[Reactive Guard] ${action}: ${rationale}`;
  }

  return {
    action,
    rationale,
    message,
    source: raw?.source || 'judge',
    model: raw?.model ?? null,
    confidence: typeof raw?.confidence === 'number' ? raw.confidence : null,
  };
}

const ACTION_CRITERIA = Object.freeze({
  continue: 'Healthy progress is occurring or issue is transient; stay silent and do not interrupt.',
  steer: 'Agent is looping, repeating an error, or rejected by reviewer; inject a concise corrective steering note.',
  interrupt_worker: 'A child subagent (isChild=true) is stuck/spinning/repeating errors; interrupt child and report concisely to parent.',
  compact: 'Healthy mid-task context bloat (~120k-150k tokens) with <2 prior compactions; compact context to keep working smoothly.',
  rotate_session: 'Root session has post-2nd-compaction bloat, clean milestone boundary, or a poisoned loop and rotationCount < maxRotationChain; create fresh continuation session with preserved goal/MEMORY.md/git status.',
  hard_stop: 'Unrecoverable spin, human blocker, rotation cap exhausted on a broken loop, or hard spend fuse; stop session and alert human.',
});

async function callOpenCodeDecisions({ ctx, model, snapshot, timeoutMs }) {
  if (typeof ctx?.experimental?.generate?.decisions !== 'function' || !model) return null;
  assertNotTerra(model);
  const choices = GUARD_ACTIONS.map((value) => ({ value, description: ACTION_CRITERIA[value] }));
  let timer = null;
  try {
    const result = await Promise.race([
      ctx.experimental.generate.decisions({
        model,
        input: [{ type: 'json', value: snapshot }],
        questions: [
          {
            type: 'choice',
            name: 'action',
            instructions: 'Select the minimal safe supervisor intervention for this session tripwire.',
            choices,
          },
        ],
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('decisions timeout')), timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
      }),
    ]);
    const answer = Array.isArray(result?.answers)
      ? result.answers.find((a) => a?.name === 'action' && a?.type === 'choice')
      : null;
    if (answer && typeof answer.choice === 'string') {
      return {
        action: answer.choice,
        rationale: `System-1 decision (${model.providerID}/${model.id}, confidence=${typeof answer.confidence === 'number' ? answer.confidence.toFixed(2) : 'n/a'})`,
        confidence: typeof answer.confidence === 'number' ? answer.confidence : null,
        source: 'opencode_decisions',
        model: `${model.providerID}/${model.id}`,
      };
    }
    return null;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function callOpenRouterSystemOne({ apiKey, endpoint, model, snapshot, timeoutMs, fetchImpl }) {
  if (!apiKey || typeof fetchImpl !== 'function') return null;
  assertNotTerra(model);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();

  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        state: snapshot,
        questions: {
          action: {
            type: 'choice',
            instructions: 'Select the minimal safe supervisor intervention for this session tripwire.',
            criteria: ACTION_CRITERIA,
          },
        },
      }),
      signal: controller.signal,
    });
    if (!response || !response.ok) return null;
    const payload = await response.json();
    const answers = payload?.answers ?? payload;
    const rawAction = answers?.action;
    const choice = typeof rawAction === 'string'
      ? rawAction
      : typeof rawAction?.choice === 'string'
        ? rawAction.choice
        : null;
    if (!choice) return null;
    const confidence = typeof rawAction?.confidence === 'number' ? rawAction.confidence : null;
    return {
      action: choice,
      rationale: `OpenRouter System-1 (${model}${confidence !== null ? `, confidence=${confidence.toFixed(2)}` : ''})`,
      confidence,
      source: 'openrouter_systemone',
      model,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function buildFallbackJudgePrompt(snapshot) {
  return [
    'You are a fast System-1 reactive guard for an autonomous coding agent.',
    'Choose the single minimal safe action from: continue, steer, interrupt_worker, compact, rotate_session, hard_stop.',
    'Rules:',
    '- continue: healthy progress or minor spend checkpoint.',
    '- steer: repeated errors, reviewer rejections, or minor root spin.',
    '- interrupt_worker: stuck/spinning child subagent (ONLY if isChild=true).',
    '- compact: healthy mid-task context bloat (~120k-150k tokens) with compactionCount < 2.',
    '- rotate_session: root session with compactionCount >= 2 bloat or poisoned loop (ONLY if isChild=false and rotationCount < maxRotationChain).',
    '- hard_stop: unrecoverable spin, human blocker, or exhausted budget/rotation cap.',
    'Respond with ONE compact JSON object ONLY: {"action":"...","rationale":"<=160 chars","message":"concise note if action!=continue"}',
    '',
    'STATE:',
    JSON.stringify(snapshot),
  ].join('\n');
}

async function callFallbackChatJudge({ ctx, models, snapshot, apiKey, timeoutMs, fetchImpl, deadline = null }) {
  const prompt = buildFallbackJudgePrompt(snapshot);
  const remaining = () => (typeof deadline === 'number' ? Math.max(0, deadline - Date.now()) : timeoutMs);

  // 1. Prefer OpenCode's native stateless `ctx.experimental.generate.text` (uses stored provider creds)
  if (typeof ctx?.experimental?.generate?.text === 'function') {
    for (const model of models) {
      assertNotTerra(model);
      const attemptTimeoutMs = remaining();
      if (attemptTimeoutMs <= 0) return null;
      let timer = null;
      try {
        const res = await Promise.race([
          ctx.experimental.generate.text({ prompt, model }),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('generate.text timeout')), attemptTimeoutMs);
            if (typeof timer.unref === 'function') timer.unref();
          }),
        ]);
        const text = typeof res === 'string' ? res : res?.text ?? '';
        const parsed = extractJsonObject(text);
        if (parsed && typeof parsed.action === 'string') {
          return {
            ...parsed,
            source: 'opencode_generate_text',
            model: `${model.providerID}/${model.id}`,
          };
        }
      } catch {
        // Try next fallback model
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  }

  // 2. Direct OpenRouter `/chat/completions` fallback when OPENROUTER_API_KEY is available
  if (apiKey && typeof fetchImpl === 'function') {
    for (const model of models) {
      assertNotTerra(model);
      const attemptTimeoutMs = remaining();
      if (attemptTimeoutMs <= 0) return null;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), attemptTimeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      try {
        const response = await fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: model.id,
            temperature: 0,
            max_tokens: 1024,
            reasoning: { effort: 'low' },
            messages: [{ role: 'user', content: prompt }],
          }),
          signal: controller.signal,
        });
        if (!response || !response.ok) continue;
        const payload = await response.json();
        const text = payload?.choices?.[0]?.message?.content ?? '';
        const parsed = extractJsonObject(text);
        if (parsed && typeof parsed.action === 'string') {
          return {
            ...parsed,
            source: 'openrouter_chat',
            model: model.id,
          };
        }
      } catch {
        // Try next fallback model
      } finally {
        clearTimeout(timer);
      }
    }
  }

  return null;
}

/**
 * Layer 1 tiered System-1 judge. Never throws; returns a validated, invariant-safe decision.
 */
export async function judgeTripwire({
  tripwire,
  state,
  chain,
  ctx,
  config,
  fetchImpl = globalThis.fetch,
  customJudge = null,
}) {
  if (tripwire.kind === 'hard_spend_fuse') {
    return deterministicFallbackDecision(tripwire, state, chain, config);
  }

  const snapshot = {
    tripwire: { kind: tripwire.kind, detail: tripwire.detail },
    sessionID: state.sessionID,
    isChild: state.isChild,
    agent: state.agent || 'build',
    steps: state.steps,
    stepsSinceProgress: Math.max(0, state.steps - state.lastProgressStep),
    compactionCount: state.compactionCount,
    latestContextTokens: state.latestContextTokens,
    sessionSpendUsd: Number(state.sessionSpendUsd.toFixed(4)),
    chainSpendUsd: Number(chain.totalSpendUsd.toFixed(4)),
    chainSpendFuseUsd: config.chainSpendFuseUsd,
    rotationCount: chain.rotationCount,
    maxRotationChain: config.maxRotationChain,
    reviewerRejections: chain.reviewerRejections,
    steerCount: state.steerCount,
    recentErrors: state.recentErrors.slice(-5),
    recentTools: state.recentTools.slice(-8),
    goalPreview: redactString(chain.goal || '', { maxLength: 240 }),
  };

  if (typeof customJudge === 'function') {
    try {
      const raw = await customJudge({ tripwire, snapshot, state, chain });
      return normalizeGuardDecision(raw, { tripwire, state, chain, config });
    } catch {
      return deterministicFallbackDecision(tripwire, state, chain, config);
    }
  }

  const apiKey = config.openrouterApiKey ?? process.env.OPENROUTER_API_KEY ?? '';
  // One shared deadline bounds the whole tiered chain (1A -> 1B -> 1C) instead of stacking
  // a fresh timeout per tier.
  const deadline = Date.now() + Math.max(config.judgeTimeoutMs, 50);
  const remaining = () => Math.max(0, deadline - Date.now());

  // Tier 1A: OpenCode native decisions API (when a decision model is configured)
  if (config.decisionModel) {
    const timeoutMs = remaining();
    if (timeoutMs > 0) {
      const dec = await callOpenCodeDecisions({ ctx, model: config.decisionModel, snapshot, timeoutMs });
      if (dec) return normalizeGuardDecision(dec, { tripwire, state, chain, config });
    }
  }

  // Tier 1B: OpenRouter native System-1 endpoint (`/api/v1/systemone`)
  if (config.systemOneEnabled !== false && apiKey) {
    const timeoutMs = remaining();
    if (timeoutMs > 0) {
      const sysOne = await callOpenRouterSystemOne({
        apiKey,
        endpoint: config.systemOneEndpoint,
        model: config.systemOneModel,
        snapshot,
        timeoutMs,
        fetchImpl,
      });
      if (sysOne) return normalizeGuardDecision(sysOne, { tripwire, state, chain, config });
    }
  }

  // Tier 1C: Fast cheap chat fallback (`gpt-6-luna` -> `deepseek-v4.1-flash-1017`)
  if (remaining() > 0) {
    const chatRes = await callFallbackChatJudge({
      ctx,
      models: config.fallbackChatModels,
      snapshot,
      apiKey,
      timeoutMs: remaining(),
      fetchImpl,
      deadline,
    });
    if (chatRes) return normalizeGuardDecision(chatRes, { tripwire, state, chain, config });
  }

  // Tier 1D: Deterministic fail-safe
  return deterministicFallbackDecision(tripwire, state, chain, config);
}

/** Build the structured handoff prompt for `rotate_session`, preserving goal, MEMORY.md, git status, and Blackboard. */
export function buildRotationHandoffPrompt({ chain, oldSessionID, reason, directory, blackboard }) {
  const memoryPath = directory ? path.join(directory, 'MEMORY.md') : '';
  const memoryExcerpt = memoryPath && fs.existsSync(memoryPath)
    ? readMemoryContext(memoryPath, HARD_MEMORY_LIMIT).trim()
    : '';
  const gitState = directory ? collectWorkspaceFallbackState(directory) : null;
  const bbPointer = blackboard && chain.rootSessionID
    ? blackboard.buildPointerBlock(chain.rootSessionID)
    : '';

  const lines = [
    `[Automatic Session Rotation ${chain.rotationCount + 1}/${chain.maxRotationChain}]`,
    `Rotated from previous session \`${oldSessionID}\` (reason: ${redactString(reason, { maxLength: 240 })}).`,
    `Shared chain spend so far: $${chain.totalSpendUsd.toFixed(2)} / $${chain.spendFuseUsd.toFixed(2)} hard fuse.`,
    '',
    '## Original Goal',
    redactString(chain.goal || '(Continue the in-progress task in this workspace.)', { maxLength: 600 }),
  ];

  if (gitState) {
    lines.push('', '## Current Workspace `git status --short`', '```');
    lines.push(gitState.ok ? gitState.gitStatus : `(unavailable: ${gitState.error})`);
    lines.push('```');
  }

  if (memoryExcerpt) {
    lines.push('', '## Project `MEMORY.md`', redactString(memoryExcerpt, { maxLength: HARD_MEMORY_LIMIT }));
  }

  if (bbPointer) {
    lines.push('', bbPointer);
  }

  lines.push(
    '',
    'Resume cleanly from current disk state without repeating already-failed steps. Verify with tests before concluding.',
  );

  return lines.join('\n');
}

/**
 * Create the in-process Always-On Reactive Security Guard instance (one per plugin/bus group).
 */
export function createReactiveGuard(options = {}) {
  const config = resolveGuardConfig(options.config ?? {}, options.env ?? process.env);
  const clock = typeof options.clock === 'function' ? options.clock : () => Date.now();
  const record = typeof options.record === 'function' ? options.record : () => {};
  const blackboard = options.blackboard ?? null;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const customJudge = typeof options.judge === 'function' ? options.judge : null;
  const onSessionRotated = typeof options.onSessionRotated === 'function' ? options.onSessionRotated : null;

  /** @type {Map<string, object>} */
  const sessions = new Map();
  /** @type {Map<string, object>} */
  const chains = new Map();

  function evictIfNeeded(map) {
    while (map.size > config.maxTrackedSessions) {
      const oldest = map.keys().next();
      if (oldest.done) break;
      map.delete(oldest.value);
    }
  }

  function getOrCreateChain(chainId, directory = null) {
    let chain = chains.get(chainId);
    if (!chain) {
      chain = {
        id: chainId,
        rootSessionID: chainId,
        directory: directory ?? null,
        goal: '',
        totalSpendUsd: 0,
        nextSpendCheckpointUsd: config.spendCheckpointUsd,
        spendFuseUsd: config.chainSpendFuseUsd,
        rotationCount: 0,
        maxRotationChain: config.maxRotationChain,
        reviewerRejections: 0,
        seenRejectionHashes: new Set(),
        createdAt: clock(),
      };
      chains.set(chainId, chain);
      evictIfNeeded(chains);
    } else if (directory && !chain.directory) {
      chain.directory = directory;
    }
    return chain;
  }

  function getOrCreateSession(sessionID, meta = {}) {
    if (typeof sessionID !== 'string' || sessionID.length === 0) return null;
    let state = sessions.get(sessionID);
    if (!state) {
      const parentSessionID = meta.parentSessionID ?? null;
      const rootSessionID = meta.rootSessionID ?? parentSessionID ?? sessionID;
      const chainId = meta.chainId ?? rootSessionID;
      state = {
        sessionID,
        chainId,
        rootSessionID,
        parentSessionID,
        isChild: Boolean(parentSessionID && parentSessionID !== sessionID),
        agent: meta.agent ?? null,
        model: meta.model ?? null,
        directory: meta.directory ?? null,
        steps: 0,
        lastProgressStep: 0,
        fileMutations: 0,
        recentEdits: [],
        recentErrors: [],
        recentTools: [],
        seenInspectionTargets: new Set(),
        lastErrorHadVerifyFailure: false,
        prevCumulativeCostUsd: 0,
        sessionSpendUsd: 0,
        prevCumulativeTokens: null,
        latestContextTokens: 0,
        compactionCount: 0,
        steerCount: 0,
        lastJudgeAt: 0,
        lastContextActionStep: -100,
        inFlight: false,
        stopped: false,
        rotatedTo: null,
      };
      sessions.set(sessionID, state);
      evictIfNeeded(sessions);
      getOrCreateChain(chainId, state.directory);
    } else {
      if (meta.directory && !state.directory) state.directory = meta.directory;
      if (meta.agent) state.agent = meta.agent;
      if (meta.model) state.model = meta.model;
      if (meta.parentSessionID && !state.parentSessionID) {
        state.parentSessionID = meta.parentSessionID;
        state.isChild = state.parentSessionID !== sessionID;
      }
      if (meta.rootSessionID && state.rootSessionID === sessionID && meta.rootSessionID !== sessionID) {
        state.rootSessionID = meta.rootSessionID;
        state.chainId = meta.chainId ?? meta.rootSessionID;
        getOrCreateChain(state.chainId, state.directory);
      }
    }
    return state;
  }

  /** Layer 0 tripwire evaluation ($0.00, pure synchronous). */
  function evaluateTripwires(state, chain) {
    if (!config.enabled || !state || state.stopped || state.rotatedTo) return null;
    const now = clock();

    // 1. Hard cumulative chain spend fuse (bypasses cooldown!)
    if (chain.totalSpendUsd >= config.chainSpendFuseUsd) {
      return {
        kind: 'hard_spend_fuse',
        detail: `chain spend $${chain.totalSpendUsd.toFixed(2)} >= hard fuse $${config.chainSpendFuseUsd.toFixed(2)}`,
      };
    }

    // Respect cooldown for non-hard-fuse tripwires so we never spam Layer 1.
    if (state.lastJudgeAt > 0 && now - state.lastJudgeAt < config.judgeCooldownMs) {
      return null;
    }

    // 2. Repeated identical errors (3x)
    if (state.recentErrors.length >= config.identicalErrorThreshold) {
      const tail = state.recentErrors.slice(-config.identicalErrorThreshold);
      if (tail.every((e) => e === tail[0])) {
        return {
          kind: 'identical_errors',
          detail: `${config.identicalErrorThreshold}x identical error: ${tail[0]}`,
        };
      }
    }

    // 3. Worker/session spin: oscillating edits OR >= N steps without forward progress
    const oscillation = detectOscillatingEdits(state.recentEdits);
    if (oscillation) {
      return {
        kind: 'worker_spin',
        detail: `oscillating edits on ${oscillation.file} (${oscillation.pattern})`,
      };
    }
    const stepsWithoutProgress = state.steps - state.lastProgressStep;
    if (stepsWithoutProgress >= config.workerSpinSteps) {
      return {
        kind: 'worker_spin',
        detail: `${stepsWithoutProgress} tool steps without file/verification progress`,
      };
    }

    // 4. Single-turn prompt context bloat (~120k-150k tokens)
    if (
      state.latestContextTokens >= config.contextBloatTokens &&
      state.steps - state.lastContextActionStep >= 2
    ) {
      return {
        kind: 'context_bloat',
        detail: `prompt context ${state.latestContextTokens} tokens >= ${config.contextBloatTokens} (compactions=${state.compactionCount})`,
      };
    }

    // 5. 2+ reviewer rejections on root chain
    if (!state.isChild && chain.reviewerRejections >= config.reviewerRejectionThreshold && chain.reviewerRejections > (chain.lastJudgedRejections ?? 0)) {
      return {
        kind: 'reviewer_rejections',
        detail: `${chain.reviewerRejections} reviewer/alt-reviewer rejections on this task`,
      };
    }

    // 6. Cumulative spend checkpoint ($3-$5 increments)
    if (chain.totalSpendUsd >= chain.nextSpendCheckpointUsd) {
      return {
        kind: 'spend_checkpoint',
        detail: `chain spend $${chain.totalSpendUsd.toFixed(2)} crossed checkpoint $${chain.nextSpendCheckpointUsd.toFixed(2)}`,
      };
    }

    return null;
  }

  /** Execute one validated guard intervention via OpenCode plugin `ctx.session.*` APIs. */
  async function executeAction({ decision, tripwire, state, chain, ctx }) {
    const action = decision.action;
    const result = { action, ok: true, newSessionID: null, error: null };

    try {
      switch (action) {
        case 'continue': {
          // A `continue` verdict must clear the tripped watermark; otherwise stale state keeps
          // re-tripping and re-calling the judge every cooldown window.
          if (tripwire.kind === 'worker_spin') {
            state.lastProgressStep = state.steps;
            state.recentEdits = [];
          } else if (tripwire.kind === 'identical_errors') {
            state.recentErrors = [];
          } else if (tripwire.kind === 'context_bloat') {
            state.lastContextActionStep = state.steps;
          }
          break;
        }

        case 'steer': {
          state.steerCount += 1;
          if (typeof ctx?.session?.synthetic === 'function') {
            await ctx.session.synthetic({
              sessionID: state.sessionID,
              text: `[Reactive Guard — Steer (${tripwire.kind})]\n${decision.message}`,
              description: `Reactive guard steer (${tripwire.kind})`,
              delivery: 'steer',
              resume: true,
              metadata: { source: 'reactive-guard', action: 'steer', tripwire: tripwire.kind },
            });
          }
          // Reset error/spin counters slightly so agent gets a fresh window to react to the steer.
          state.recentErrors = [];
          state.recentEdits = [];
          state.lastProgressStep = state.steps;
          break;
        }

        case 'interrupt_worker': {
          state.stopped = true;
          if (typeof ctx?.session?.interrupt === 'function') {
            await ctx.session.interrupt({ sessionID: state.sessionID, resume: false });
          }
          const fallback = state.directory ? collectWorkspaceFallbackState(state.directory) : null;
          const summary = [
            `[Reactive Guard — Interrupted Stuck Worker]`,
            `Child \`${state.sessionID}\` (${state.agent || 'subagent'}) was interrupted after tripwire \`${tripwire.kind}\`: ${tripwire.detail}.`,
            `Reason: ${decision.rationale}`,
            `Steps: ${state.steps}, Spend: $${state.sessionSpendUsd.toFixed(4)}`,
            fallback ? `Workspace git status --short:\n${fallback.ok ? fallback.gitStatus : `(unavailable: ${fallback.error})`}` : '',
          ]
            .filter(Boolean)
            .join('\n');

          if (blackboard) {
            try {
              blackboard.recordSubagentReport({
                rootSessionID: state.rootSessionID,
                sessionID: state.sessionID,
                agent: state.agent || 'subagent',
                description: `Interrupted by reactive guard (${tripwire.kind})`,
                text: summary,
                status: 'interrupted',
                directory: state.directory,
              });
            } catch {
              // ignore blackboard error
            }
          }

          if (state.parentSessionID && typeof ctx?.session?.synthetic === 'function') {
            await ctx.session.synthetic({
              sessionID: state.parentSessionID,
              text: summary,
              description: `Stuck worker ${state.sessionID} interrupted`,
              delivery: 'queue',
              resume: true,
              metadata: { source: 'reactive-guard', action: 'interrupt_worker', childID: state.sessionID },
            });
          }
          break;
        }

        case 'compact': {
          state.lastContextActionStep = state.steps;
          if (typeof ctx?.session?.compact === 'function') {
            await ctx.session.compact({
              sessionID: state.sessionID,
              delivery: 'queue',
            });
          }
          break;
        }

        case 'rotate_session': {
          // 1. Validate every pre-condition BEFORE any side effect.
          if (chain.rotationCount >= config.maxRotationChain) {
            throw new Error(`rotation cap ${config.maxRotationChain} already reached`);
          }
          const parsedModel = state.model ? parseModelRef(state.model) : null;
          const directory = state.directory || chain.directory || null;
          const handoffPrompt = buildRotationHandoffPrompt({
            chain,
            oldSessionID: state.sessionID,
            reason: decision.rationale || tripwire.detail,
            directory,
            blackboard,
          });

          // 2. Create the fresh continuation session FIRST. The old session is still running, so
          //    a failure here leaves it fully usable.
          let created = null;
          if (typeof ctx?.session?.create === 'function') {
            created = await ctx.session.create({
              title: `Continued (rot ${chain.rotationCount + 1}/${config.maxRotationChain}): ${redactString(chain.goal || 'Session', { maxLength: 60 })}`,
              agent: state.agent || 'build',
              ...(parsedModel ? { model: parsedModel } : {}),
              ...(directory ? { location: { directory } } : {}),
              metadata: {
                rotatedFrom: state.sessionID,
                rootChainID: chain.id,
                rotationIndex: chain.rotationCount + 1,
              },
            });
          }

          const newSessionID = created?.id ?? created?.sessionID ?? null;
          if (!newSessionID) {
            throw new Error('ctx.session.create did not return a new session id');
          }

          // 3. Kick off the new session with the preserved handoff SECOND. If this fails, stop the
          //    half-started session best-effort and rethrow: the old session is untouched.
          try {
            if (typeof ctx?.session?.prompt !== 'function') {
              throw new Error('ctx.session.prompt is unavailable');
            }
            await ctx.session.prompt({
              sessionID: newSessionID,
              text: handoffPrompt,
            });
          } catch (error) {
            try {
              await ctx.session.interrupt?.({ sessionID: newSessionID, resume: false });
            } catch {
              // Best-effort cleanup of the new session only.
            }
            throw error;
          }

          // 4. Both create and prompt succeeded -> commit the rotation.
          chain.rotationCount += 1;
          state.rotatedTo = newSessionID;
          state.stopped = true;
          result.newSessionID = newSessionID;

          // 5. Register the new session in the SAME chain (preserving cumulative spend fuse & rotation count!)
          const nextState = getOrCreateSession(newSessionID, {
            chainId: chain.id,
            rootSessionID: chain.rootSessionID,
            parentSessionID: null,
            agent: state.agent || 'build',
            model: state.model,
            directory,
          });
          if (nextState) nextState.lastJudgeAt = clock();
          try {
            onSessionRotated?.({
              oldSessionID: state.sessionID,
              newSessionID,
              rootSessionID: chain.rootSessionID,
              chainID: chain.id,
              directory,
              agent: state.agent || 'build',
              model: state.model,
            });
          } catch {
            // ignore
          }

          // 6. Interrupt the old session only now that the continuation is live.
          try {
            if (typeof ctx?.session?.interrupt === 'function') {
              await ctx.session.interrupt({ sessionID: state.sessionID, resume: false });
            }
          } catch {
            // ignore: rotation already completed
          }

          // 7. Write the visible handoff pointer into the OLD OpenChamber chat (`resume: false`
          //    so the old chat stays idle). Isolated so it can never fail a completed rotation.
          try {
            if (typeof ctx?.session?.synthetic === 'function') {
              await ctx.session.synthetic({
                sessionID: state.sessionID,
                text: `[Reactive Guard — Session Rotated (${chain.rotationCount}/${config.maxRotationChain})]\nContinued automatically in new session \`${newSessionID}\`.\nReason: ${decision.rationale}\nShared chain spend: $${chain.totalSpendUsd.toFixed(2)} / $${config.chainSpendFuseUsd.toFixed(2)}.\nOpen \`${newSessionID}\` in the OpenChamber sidebar to follow progress.`,
                description: `Rotated to ${newSessionID}`,
                delivery: 'queue',
                resume: false,
                metadata: { source: 'reactive-guard', action: 'rotate_session', rotatedTo: newSessionID },
              });
            }
          } catch {
            // A failed pointer must not abort a completed rotation.
          }
          break;
        }

        case 'hard_stop': {
          state.stopped = true;
          if (typeof ctx?.session?.interrupt === 'function') {
            await ctx.session.interrupt({ sessionID: state.sessionID, resume: false });
          }
          if (typeof ctx?.session?.synthetic === 'function') {
            await ctx.session.synthetic({
              sessionID: state.sessionID,
              text: `[Reactive Guard — HARD STOP (${tripwire.kind})]\n${decision.message}\nRationale: ${decision.rationale}\nCumulative chain spend: $${chain.totalSpendUsd.toFixed(2)} / $${config.chainSpendFuseUsd.toFixed(2)}.\nExecution paused cleanly — awaiting human direction.`,
              description: `Hard stop (${tripwire.kind})`,
              delivery: 'queue',
              resume: false,
              metadata: { source: 'reactive-guard', action: 'hard_stop', tripwire: tripwire.kind },
            });
          }
          break;
        }
      }
    } catch (error) {
      result.ok = false;
      result.error = redactSecrets(String(error?.message ?? error), config.openrouterApiKey ?? process.env.OPENROUTER_API_KEY);
      if (action === 'rotate_session' && !state.rotatedTo) {
        // Rotation never completed: keep the old session running and make the failure visible.
        state.stopped = false;
        try {
          if (typeof ctx?.session?.synthetic === 'function') {
            await ctx.session.synthetic({
              sessionID: state.sessionID,
              text: `[Reactive Guard — Session rotation failed]\nThe automatic handoff to a fresh session did not complete (${tripwire.kind}).\nError: ${result.error}\nThis session is still running; continue the task here or ask a human to intervene.`,
              description: 'Session rotation failed',
              delivery: 'queue',
              resume: false,
              metadata: { source: 'reactive-guard', action: 'rotate_session', ok: false },
            });
          }
        } catch {
          // Best-effort notice only.
        }
      }
    }

    record('guard.action', {
      sessionID: state.sessionID,
      chainID: chain.id,
      isChild: state.isChild,
      tripwire: tripwire.kind,
      tripwireDetail: redactString(tripwire.detail, { maxLength: 240 }),
      action: decision.action,
      source: decision.source,
      model: decision.model ?? null,
      confidence: decision.confidence ?? null,
      rationale: decision.rationale,
      ok: result.ok,
      newSessionID: result.newSessionID,
      error: result.error,
      chainSpendUsd: Number(chain.totalSpendUsd.toFixed(4)),
      rotationCount: chain.rotationCount,
      latestContextTokens: state.latestContextTokens,
    });

    return result;
  }

  /** Evaluate Layer 0 tripwires and, ONLY when tripped, run Layer 1 judge + execute action. */
  async function checkAndIntervene(sessionID, ctx) {
    const state = sessions.get(sessionID);
    if (!state || state.inFlight || state.stopped || state.rotatedTo) return null;
    const chain = getOrCreateChain(state.chainId, state.directory);
    const tripwire = evaluateTripwires(state, chain);
    if (!tripwire) return null;

    state.inFlight = true;
    state.lastJudgeAt = clock();
    if (tripwire.kind === 'spend_checkpoint') {
      while (chain.nextSpendCheckpointUsd <= chain.totalSpendUsd) {
        chain.nextSpendCheckpointUsd += config.spendCheckpointUsd;
      }
    }
    if (tripwire.kind === 'reviewer_rejections') {
      chain.lastJudgedRejections = chain.reviewerRejections;
    }

    try {
      const decision = await judgeTripwire({
        tripwire,
        state,
        chain,
        ctx,
        config,
        fetchImpl,
        customJudge,
      });
      const outcome = await executeAction({ decision, tripwire, state, chain, ctx });
      return { tripwire, decision, outcome };
    } finally {
      state.inFlight = false;
    }
  }

  // --- Observation methods invoked from plugin hooks & shared event bus ---

  function onPrompt({ sessionID, text, directory, parentSessionID = null, rootSessionID = null }) {
    const state = getOrCreateSession(sessionID, { directory, parentSessionID, rootSessionID });
    if (!state) return;
    // User sending a new prompt clears any prior soft stop so human can resume cleanly!
    state.stopped = false;
    const chain = getOrCreateChain(state.chainId, directory);
    if (!state.isChild && !chain.goal && typeof text === 'string' && text.trim().length > 0) {
      chain.goal = redactString(text.trim(), { maxLength: 500 });
    }
  }

  function onSessionContext({ sessionID, agent, model, directory, parentSessionID = null, rootSessionID = null }) {
    getOrCreateSession(sessionID, { agent, model, directory, parentSessionID, rootSessionID });
  }

  function onSubagentSpawn({ parentSessionID, childSessionID, agent, directory }) {
    const parent = getOrCreateSession(parentSessionID, { directory });
    if (!parent || !childSessionID) return;
    getOrCreateSession(childSessionID, {
      chainId: parent.chainId,
      rootSessionID: parent.rootSessionID,
      parentSessionID,
      agent,
      directory: directory ?? parent.directory,
    });
  }

  async function onReviewerOutput({ rootSessionID, parentSessionID, childSessionID, agent, text, ctx }) {
    if (!isReviewerRejectionText(agent, text)) return null;
    const targetSessionID = parentSessionID || rootSessionID;
    const state = getOrCreateSession(targetSessionID, { rootSessionID });
    if (!state) return null;
    const chain = getOrCreateChain(state.chainId, state.directory);
    const key = `${childSessionID || 'rev'}:${crypto.createHash('sha256').update(String(text).slice(0, 500)).digest('hex').slice(0, 12)}`;
    if (chain.seenRejectionHashes.has(key)) return null;
    chain.seenRejectionHashes.add(key);
    chain.reviewerRejections += 1;
    return checkAndIntervene(state.sessionID, ctx);
  }

  async function onToolAfter({
    sessionID,
    tool,
    status,
    input,
    error,
    agent,
    directory,
    parentSessionID = null,
    rootSessionID = null,
    ctx,
  }) {
    const state = getOrCreateSession(sessionID, { agent, directory, parentSessionID, rootSessionID });
    if (!state || state.stopped || state.rotatedTo) return null;

    state.steps += 1;
    const toolName = String(tool || 'tool').toLowerCase();
    state.recentTools.push(`${toolName}:${status || 'ok'}`);
    if (state.recentTools.length > 20) state.recentTools.shift();

    if (status === 'error') {
      const sig = normalizeErrorSignature(toolName, error);
      state.recentErrors.push(sig);
      if (state.recentErrors.length > 10) state.recentErrors.shift();
      if (toolName === 'shell' || toolName === 'bash') {
        const cmd = String(input?.command ?? '');
        if (VERIFY_SHELL_RE.test(cmd)) state.lastErrorHadVerifyFailure = true;
      }
    } else {
      // Successful file mutation advances progress unless it is an oscillating edit
      if (FILE_MUTATION_TOOLS.has(toolName)) {
        state.fileMutations += 1;
        let filePath = String(input?.path ?? input?.filePath ?? input?.file ?? '');
        if (!filePath) {
          // `apply_patch` carries its changes in `patchText` rather than a `path` field.
          const patchText = input?.patchText ?? input?.patch ?? input?.diff;
          if (typeof patchText === 'string') {
            const match = /^\*\*\*\s+(?:Update|Add|Delete)\s+File:\s*(.+)$/m.exec(patchText)
              ?? /^\+\+\+\s+(?:b\/)?(.+)$/m.exec(patchText);
            if (match) filePath = String(match[1] ?? '').trim();
          }
        }
        const payloadStr = JSON.stringify(input ?? '').slice(0, 2000);
        const editSig = crypto.createHash('sha256').update(payloadStr).digest('hex').slice(0, 12);
        // Always record (even without a path) and always advance progress unless oscillating.
        state.recentEdits.push({ file: filePath || '__mutation__', sig: editSig });
        if (state.recentEdits.length > config.oscillationWindow) state.recentEdits.shift();
        if (!detectOscillatingEdits(state.recentEdits)) {
          state.lastProgressStep = state.steps;
        }
      } else if ((toolName === 'shell' || toolName === 'bash') && VERIFY_SHELL_RE.test(String(input?.command ?? ''))) {
        // Passing verification test/build counts as concrete forward progress
        state.lastProgressStep = state.steps;
        state.lastErrorHadVerifyFailure = false;
        state.recentErrors = [];
      } else {
        // Target-based inspection progress applies to EVERY agent (build, worker, reviewer, ...):
        // inspecting a *new* distinct file/query/URL/command is forward progress; only repeating
        // identical targets without new discovery counts as spin.
        const target = String(
          input?.path ??
            input?.filePath ??
            input?.file ??
            input?.pattern ??
            input?.query ??
            input?.url ??
            input?.command ??
            input?.description ??
            '',
        ).trim().slice(0, 200);
        const key = `${toolName}:${target}`;
        if (target && !state.seenInspectionTargets.has(key)) {
          if (state.seenInspectionTargets.size < 500) state.seenInspectionTargets.add(key);
          state.lastProgressStep = state.steps;
        }
      }
    }

    return checkAndIntervene(sessionID, ctx);
  }

  async function onUsageUpdated({ sessionID, cost, tokens, directory, parentSessionID = null, rootSessionID = null, ctx }) {
    const state = getOrCreateSession(sessionID, { directory, parentSessionID, rootSessionID });
    if (!state) return null;
    const chain = getOrCreateChain(state.chainId, state.directory);

    // 1. Spend accounting FIRST, even for stopped children or rotated-away sessions, because
    //    interrupted turns and rotated sessions keep billing and must count toward the shared fuse.
    //    `cost` is a cumulative session total, so only a monotonic increase adds a delta.
    const rawCost = typeof cost === 'string' ? cost.trim() : cost;
    let numCost = null;
    if (typeof rawCost === 'number') numCost = rawCost;
    else if (typeof rawCost === 'string' && rawCost.length > 0) numCost = Number(rawCost);
    if (numCost !== null && Number.isFinite(numCost) && numCost >= 0) {
      if (numCost > state.prevCumulativeCostUsd) {
        const deltaCost = numCost - state.prevCumulativeCostUsd;
        state.prevCumulativeCostUsd = numCost;
        state.sessionSpendUsd += deltaCost;
        chain.totalSpendUsd += deltaCost;
      }
    }

    if (state.stopped || state.rotatedTo) return null;

    // 2. Single-turn prompt context tokens (computed from cumulative usage deltas!).
    if (tokens && typeof tokens === 'object') {
      const curIn = Number(tokens.input ?? 0) || 0;
      const curCr = Number(tokens.cache?.read ?? tokens.cacheRead ?? 0) || 0;
      const curCw = Number(tokens.cache?.write ?? tokens.cacheWrite ?? 0) || 0;
      const curTotal = curIn + curCr + curCw;

      if (state.prevCumulativeTokens === null) {
        // First observation for this session: if <= 500k, treat as Turn-1 prompt size;
        // if > 500k (e.g. daemon restarted mid-session and emitted multi-million cumulative total),
        // baseline cleanly and measure exact per-turn delta starting on the next event.
        if (curTotal <= 500_000) {
          state.latestContextTokens = curTotal;
        }
        state.prevCumulativeTokens = { in: curIn, cr: curCr, cw: curCw };
      } else {
        const dIn = Math.max(0, curIn - state.prevCumulativeTokens.in);
        const dCr = Math.max(0, curCr - state.prevCumulativeTokens.cr);
        const dCw = Math.max(0, curCw - state.prevCumulativeTokens.cw);
        const turnPrompt = dIn + dCr + dCw;
        if (turnPrompt > 0) {
          state.latestContextTokens = turnPrompt;
        }
        state.prevCumulativeTokens = { in: curIn, cr: curCr, cw: curCw };
      }
    }

    return checkAndIntervene(sessionID, ctx);
  }

  function onCompactionEnded({ sessionID }) {
    const state = sessions.get(sessionID);
    if (!state) return;
    state.compactionCount += 1;
    state.latestContextTokens = 0;
    state.lastContextActionStep = state.steps;
  }

  function getSessionState(sessionID) {
    return sessions.get(sessionID) ?? null;
  }

  function getChainState(chainId) {
    return chains.get(chainId) ?? null;
  }

  return {
    config,
    onPrompt,
    onSessionContext,
    onSubagentSpawn,
    onReviewerOutput,
    onToolAfter,
    onUsageUpdated,
    onCompactionEnded,
    evaluateTripwires,
    checkAndIntervene,
    getSessionState,
    getChainState,
  };
}
