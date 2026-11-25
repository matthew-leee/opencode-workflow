/**
 * Wave 2 — Offline test suite for the Always-On Reactive Security Guard.
 *
 * Covers:
 *   Layer 0  : $0.00 deterministic tripwires (errors, spin, bloat, spend, reviewer, Terra ban)
 *   Layer 1  : tiered System-1 judge (decisions -> systemone -> generate.text -> fail-safe)
 *   Executor : all 6 actions + hard invariants (root interrupt_worker, max-2 rotation cap,
 *              shared chain spend fuse across rotated sessions)
 *   Layer 2  : automatic bounded `MEMORY.md` refresh (eligibility, cooldown, backup, cap)
 *   RSI      : weekly native automation spec builder + idempotent registration
 *   E2E      : plugin hook flow through `plugins/audit-logger/index.js`
 *
 * Zero paid LLM calls and zero network calls: every judge/LLM/fetch is mocked.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import auditPlugin, {
  AUDIT_DIR_ENV,
  BLACKBOARD_DIR_ENV,
  assertNotTerra as exportedAssertNotTerra,
  isBannedModel as exportedIsBannedModel,
  resetSharedBusForTests,
} from '../plugins/audit-logger/index.js';
import {
  GUARD_ACTIONS,
  assertNotTerra,
  buildRotationHandoffPrompt,
  createReactiveGuard,
  detectOscillatingEdits,
  deterministicFallbackDecision,
  isBannedModel,
  isReviewerRejectionText,
  judgeTripwire,
  normalizeErrorSignature,
  normalizeGuardDecision,
  parseModelRef,
  resolveGuardConfig,
} from '../plugins/audit-logger/reactive-guard.js';
import {
  createMemoryRefresher,
  isEligibleMemoryWorkspace,
  makePluginTextLlm,
} from '../plugins/audit-logger/memory-refresh.js';
import { getSharedBus } from '../plugins/audit-logger/shared-bus.js';
import {
  DEFAULT_RSI_TZ,
  WEEKLY_RSI_CRON,
  WEEKLY_RSI_AUTOMATION_NAME,
  buildWeeklyRsiAutomationSpec,
  ensureWeeklyRsiAutomation,
  shellQuotePosix,
} from '../src/rsi-schedule.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const REPO_ROOT = path.resolve(HERE, '..');
const TMP_BASE = fs.existsSync('/tmp/opencode') ? '/tmp/opencode' : os.tmpdir();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(t, prefix = 'ocw-wave2-') {
  const dir = fs.mkdtempSync(path.join(TMP_BASE, prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function useEnv(t, overrides) {
  const saved = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of saved.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function readAllJsonl(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .sort()
    .flatMap((name) =>
      fs
        .readFileSync(path.join(dir, name), 'utf8')
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line)),
    );
}

function initGitRepo(dir) {
  const result = spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git init failed: ${result.stderr || result.status}`);
  fs.writeFileSync(path.join(dir, 'work.txt'), 'hello\n');
}

function judgeSpy(decide = () => ({ action: 'continue' })) {
  const calls = [];
  const fn = async (args) => {
    calls.push(args);
    return decide(args);
  };
  return { fn, calls };
}

/** A controllable `ctx.event` domain: tests `push()` events, the plugin's subscriber yields them. */
function makePushEventDomain() {
  let closed = false;
  const buffered = [];
  const waiters = [];
  return {
    domain: {
      subscribe({ signal } = {}) {
        return (async function* stream() {
          while (!closed) {
            if (signal?.aborted) return;
            if (buffered.length > 0) {
              yield buffered.shift();
              continue;
            }
            await new Promise((resolve) => {
              waiters.push(resolve);
              if (signal) signal.addEventListener('abort', () => resolve(), { once: true });
            });
          }
        })();
      },
    },
    push(event) {
      buffered.push(event);
      const waiter = waiters.shift();
      if (waiter) waiter();
    },
    close() {
      closed = true;
      for (const waiter of waiters.splice(0)) waiter();
    },
  };
}

/** Spin the event loop until `predicate()` is true (bounded, no wall-clock sleeps). */
async function waitFor(predicate, attempts = 200) {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return true;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return predicate();
}

/**
 * Build a reactive guard with a fully mocked `ctx.session.*` surface, a controllable
 * clock, and a recording `record()` sink. No real OpenCode host and no network.
 */
function makeGuard(options = {}) {
  const records = [];
  const calls = { synthetic: [], interrupt: [], compact: [], create: [], prompt: [] };
  const createIds = [...(options.createIds ?? [])];
  let now = 1_000_000;
  const clock = () => now;

  const ctx = {
    session: {
      async synthetic(args) {
        calls.synthetic.push(args);
      },
      async interrupt(args) {
        calls.interrupt.push(args);
      },
      async compact(args) {
        calls.compact.push(args);
      },
      async create(args) {
        calls.create.push(args);
        const id = createIds.length > 0 ? createIds.shift() : `ses_created_${calls.create.length}`;
        return { id };
      },
      async prompt(args) {
        calls.prompt.push(args);
      },
    },
  };

  const guard = createReactiveGuard({
    config: { judgeCooldownMs: 0, ...(options.config ?? {}) },
    judge: options.judge ?? null,
    blackboard: options.blackboard ?? null,
    clock,
    record: (event, data) => records.push({ event, data }),
  });

  return {
    guard,
    ctx,
    records,
    calls,
    clock,
    advance(ms = 0) {
      now += ms;
    },
    guardActions() {
      return records.filter((entry) => entry.event === 'guard.action').map((entry) => entry.data);
    },
  };
}

function makeJudgeState(overrides = {}) {
  return {
    sessionID: 'ses_judge',
    isChild: false,
    agent: 'build',
    steps: 5,
    lastProgressStep: 0,
    compactionCount: 0,
    latestContextTokens: 200_000,
    sessionSpendUsd: 1,
    recentErrors: ['shell:boom'],
    recentTools: ['read:completed'],
    steerCount: 0,
    ...overrides,
  };
}

function makeJudgeChain(overrides = {}) {
  return {
    id: 'ses_judge',
    rootSessionID: 'ses_judge',
    totalSpendUsd: 0,
    rotationCount: 0,
    reviewerRejections: 0,
    goal: 'Test goal',
    ...overrides,
  };
}

function createMockContext({ directory, options = {}, session = {} }) {
  const callbacks = new Map();
  const makeDomain = (name, extra = {}) => ({
    ...extra,
    async hook(hookName, callback) {
      const key = `${name}.${hookName}`;
      callbacks.set(key, callback);
      return {
        key,
        async dispose() {
          callbacks.delete(key);
        },
      };
    },
  });

  const event = {
    subscribe({ signal } = {}) {
      return (async function* emptyStream() {
        if (!signal) return;
        await new Promise((resolve) => {
          if (signal.aborted) return resolve();
          signal.addEventListener('abort', resolve, { once: true });
        });
      })();
    },
  };

  const ctx = {
    app: { name: 'opencode', version: '2.4.1', channel: 'latest' },
    location: { directory },
    options,
    session: makeDomain('session', session),
    tool: makeDomain('tool'),
    permission: makeDomain('permission'),
    shell: makeDomain('shell'),
    event,
  };

  return {
    ctx,
    callbacks,
    async call(hook, input) {
      const fn = callbacks.get(hook);
      assert.ok(fn, `hook ${hook} not registered`);
      return fn(input);
    },
  };
}

// ===========================================================================
// 1. LAYER 0 — deterministic, $0.00 tripwires
// ===========================================================================

test('Layer 0: healthy session (edits, passing tests, normal tokens, low spend) makes ZERO judge calls', async () => {
  const spy = judgeSpy(() => ({ action: 'continue' }));
  const { guard, ctx, guardActions } = makeGuard({ judge: spy.fn });

  guard.onPrompt({ sessionID: 'ses_healthy', text: 'Do healthy work', directory: null });

  await guard.onToolAfter({
    sessionID: 'ses_healthy',
    tool: 'edit',
    status: 'completed',
    input: { path: '/p/a.js', content: 'v1' },
    agent: 'build',
    ctx,
  });
  await guard.onToolAfter({
    sessionID: 'ses_healthy',
    tool: 'edit',
    status: 'completed',
    input: { path: '/p/a.js', content: 'v2' },
    agent: 'build',
    ctx,
  });
  await guard.onToolAfter({
    sessionID: 'ses_healthy',
    tool: 'shell',
    status: 'completed',
    input: { command: 'node --test test/x.test.mjs' },
    agent: 'build',
    ctx,
  });
  await guard.onUsageUpdated({ sessionID: 'ses_healthy', cost: 1.5, tokens: { input: 50_000 }, ctx });
  await guard.onToolAfter({
    sessionID: 'ses_healthy',
    tool: 'shell',
    status: 'error',
    input: { command: 'npm test' },
    error: 'Error: boom',
    agent: 'build',
    ctx,
  });
  await guard.onToolAfter({
    sessionID: 'ses_healthy',
    tool: 'shell',
    status: 'error',
    input: { command: 'npm test' },
    error: 'Error: boom',
    agent: 'build',
    ctx,
  });

  assert.equal(spy.calls.length, 0, 'healthy session must not call the Layer 1 judge');
  assert.equal(guardActions().length, 0, 'healthy session must not record guard actions');
  assert.equal(guard.getChainState('ses_healthy').totalSpendUsd, 1.5);
});

test('Layer 0: read-only agents inspecting 20+ DISTINCT targets never spin, but 16+ repeats do', async () => {
  const distinctSpy = judgeSpy(() => ({ action: 'continue' }));
  const distinct = makeGuard({ judge: distinctSpy.fn });
  distinct.guard.onPrompt({ sessionID: 'ses_review_distinct', text: 'review', directory: null });
  for (let i = 0; i < 22; i += 1) {
    await distinct.guard.onToolAfter({
      sessionID: 'ses_review_distinct',
      tool: 'read',
      status: 'completed',
      input: { path: `/p/distinct-${i}.js` },
      agent: 'reviewer',
      ctx: distinct.ctx,
    });
  }
  assert.equal(distinctSpy.calls.length, 0, 'distinct inspections are forward progress');
  const distinctState = distinct.guard.getSessionState('ses_review_distinct');
  assert.equal(distinctState.steps, 22);
  assert.equal(distinctState.lastProgressStep, 22, 'every distinct inspection counts as progress');

  const repeatSpy = judgeSpy(() => ({ action: 'continue' }));
  const repeat = makeGuard({ judge: repeatSpy.fn });
  repeat.guard.onPrompt({ sessionID: 'ses_review_repeat', text: 'review', directory: null });
  for (let i = 0; i < 17; i += 1) {
    await repeat.guard.onToolAfter({
      sessionID: 'ses_review_repeat',
      tool: 'read',
      status: 'completed',
      input: { path: '/p/same-target.js' },
      agent: 'reviewer',
      ctx: repeat.ctx,
    });
  }
  assert.equal(repeatSpy.calls.length, 1);
  assert.equal(repeatSpy.calls[0].tripwire.kind, 'worker_spin');
  assert.match(repeatSpy.calls[0].tripwire.detail, /without file\/verification progress/);
});

test('Layer 0: 3x identical errors (normalized) triggers identical_errors', async () => {
  const spy = judgeSpy(() => ({ action: 'continue' }));
  const { guard, ctx } = makeGuard({ judge: spy.fn });
  guard.onPrompt({ sessionID: 'ses_err', text: 'debug', directory: null });

  const variants = [
    'Error at 2026-01-01T00:00:00Z on line 12345',
    'Error at 2026-02-02T01:02:03.456Z on line 99999',
    'Error at 2026-03-03T04:05:06Z on line 100000',
  ];
  for (const error of variants) {
    await guard.onToolAfter({
      sessionID: 'ses_err',
      tool: 'shell',
      status: 'error',
      input: { command: 'npm test' },
      error,
      agent: 'build',
      ctx,
    });
  }

  assert.equal(spy.calls.length, 1);
  assert.equal(spy.calls[0].tripwire.kind, 'identical_errors');
  assert.match(spy.calls[0].tripwire.detail, /3x identical error/);
});

test('Layer 0: worker spin via 16 steps without progress and via A->B->A oscillating edits', async () => {
  const stepSpy = judgeSpy(() => ({ action: 'continue' }));
  const stepped = makeGuard({ judge: stepSpy.fn });
  stepped.guard.onPrompt({ sessionID: 'ses_spin_steps', text: 'work', directory: null });
  // Genuine spin: the target is discovered once, then the SAME file is re-read 16 times.
  for (let i = 0; i < 17; i += 1) {
    await stepped.guard.onToolAfter({
      sessionID: 'ses_spin_steps',
      tool: 'read',
      status: 'completed',
      input: { path: '/p/spin-same.js' },
      agent: 'build',
      ctx: stepped.ctx,
    });
  }
  assert.equal(stepSpy.calls.length, 1);
  assert.equal(stepSpy.calls[0].tripwire.kind, 'worker_spin');
  assert.match(stepSpy.calls[0].tripwire.detail, /16 tool steps without file\/verification progress/);

  const oscSpy = judgeSpy(() => ({ action: 'continue' }));
  const osc = makeGuard({ judge: oscSpy.fn });
  osc.guard.onPrompt({ sessionID: 'ses_spin_osc', text: 'edit', directory: null });
  for (const content of ['A', 'B', 'A']) {
    await osc.guard.onToolAfter({
      sessionID: 'ses_spin_osc',
      tool: 'edit',
      status: 'completed',
      input: { path: '/p/osc.js', content },
      agent: 'build',
      ctx: osc.ctx,
    });
  }
  assert.equal(oscSpy.calls.length, 1);
  assert.equal(oscSpy.calls[0].tripwire.kind, 'worker_spin');
  assert.match(oscSpy.calls[0].tripwire.detail, /A->B->A oscillation/);

  // Unit-level sanity for the pure detector.
  assert.deepEqual(
    detectOscillatingEdits([
      { file: '/x', sig: 'a' },
      { file: '/x', sig: 'b' },
      { file: '/x', sig: 'a' },
    ]),
    { file: '/x', pattern: 'A->B->A oscillation', edits: 3 },
  );
});

test('Layer 0: context bloat uses cumulative usage deltas (50k -> 190k = 140k turn delta)', async () => {
  const spy = judgeSpy(() => ({ action: 'continue' }));
  const { guard, ctx } = makeGuard({ judge: spy.fn });
  guard.onPrompt({ sessionID: 'ses_bloat', text: 'big task', directory: null });

  await guard.onUsageUpdated({ sessionID: 'ses_bloat', tokens: { input: 50_000 }, ctx });
  assert.equal(spy.calls.length, 0, 'turn 1 at 50k tokens is healthy');
  assert.equal(guard.getSessionState('ses_bloat').latestContextTokens, 50_000);

  await guard.onUsageUpdated({ sessionID: 'ses_bloat', tokens: { input: 190_000 }, ctx });
  assert.equal(spy.calls.length, 1);
  assert.equal(spy.calls[0].tripwire.kind, 'context_bloat');
  assert.equal(guard.getSessionState('ses_bloat').latestContextTokens, 140_000);
});

test('Layer 0: multi-million mid-session baseline (22M) is baselined cleanly, then real delta is measured', async () => {
  const spy = judgeSpy(() => ({ action: 'continue' }));
  const { guard, ctx } = makeGuard({ judge: spy.fn });
  guard.onPrompt({ sessionID: 'ses_baseline', text: 'resumed daemon', directory: null });

  await guard.onUsageUpdated({ sessionID: 'ses_baseline', tokens: { input: 22_000_000 }, ctx });
  assert.equal(spy.calls.length, 0, 'first multi-million observation must not false-trigger');
  assert.equal(guard.getSessionState('ses_baseline').latestContextTokens, 0);

  await guard.onUsageUpdated({ sessionID: 'ses_baseline', tokens: { input: 22_140_000 }, ctx });
  assert.equal(spy.calls.length, 1);
  assert.equal(spy.calls[0].tripwire.kind, 'context_bloat');
  assert.equal(guard.getSessionState('ses_baseline').latestContextTokens, 140_000);
});

test('Layer 0: $4 spend checkpoint fires once and advances the next checkpoint to $8', async () => {
  const spy = judgeSpy(() => ({ action: 'continue' }));
  const { guard, ctx } = makeGuard({ judge: spy.fn });
  guard.onPrompt({ sessionID: 'ses_spend', text: 'spendy', directory: null });

  await guard.onUsageUpdated({ sessionID: 'ses_spend', cost: 4.0, ctx });
  assert.equal(spy.calls.length, 1);
  assert.equal(spy.calls[0].tripwire.kind, 'spend_checkpoint');

  const chain = guard.getChainState('ses_spend');
  assert.equal(chain.nextSpendCheckpointUsd, 8);

  await guard.onUsageUpdated({ sessionID: 'ses_spend', cost: 4.5, ctx });
  assert.equal(spy.calls.length, 1, 'below the advanced checkpoint must stay quiet');
  assert.equal(chain.totalSpendUsd, 4.5);
});

test('Layer 0: $15 hard chain spend fuse triggers deterministic hard_stop with ZERO judge calls', async () => {
  const spy = judgeSpy(() => ({ action: 'continue' }));
  const { guard, ctx, calls, guardActions } = makeGuard({ judge: spy.fn });
  guard.onPrompt({ sessionID: 'ses_fuse', text: 'fuse', directory: null });

  await guard.onUsageUpdated({ sessionID: 'ses_fuse', cost: 15.0, ctx });

  assert.equal(spy.calls.length, 0, 'hard fuse must bypass the LLM judge entirely');
  const actions = guardActions();
  assert.equal(actions.length, 1);
  assert.equal(actions[0].action, 'hard_stop');
  assert.equal(actions[0].tripwire, 'hard_spend_fuse');
  assert.equal(actions[0].source, 'deterministic_fuse');
  assert.equal(calls.interrupt.length, 1);
  assert.equal(calls.interrupt[0].resume, false);
  assert.equal(calls.synthetic.length, 1);
  assert.equal(calls.synthetic[0].resume, false);
  assert.match(calls.synthetic[0].text, /HARD STOP/);
});

test('Layer 0: 2+ reviewer/alt-reviewer FAIL reports trigger reviewer_rejections, PASS reports are ignored', async () => {
  const spy = judgeSpy(() => ({ action: 'continue' }));
  const { guard, ctx } = makeGuard({ judge: spy.fn });

  const first = await guard.onReviewerOutput({
    rootSessionID: 'ses_root',
    parentSessionID: null,
    childSessionID: 'ses_rev_1',
    agent: 'reviewer',
    text: 'VERDICT: FAIL\n- 3 blocking findings',
    ctx,
  });
  assert.equal(first, null, 'one rejection is below the threshold');

  const second = await guard.onReviewerOutput({
    rootSessionID: 'ses_root',
    parentSessionID: null,
    childSessionID: 'ses_rev_2',
    agent: 'alt-reviewer',
    text: 'VERDICT: FAIL\n- 2 blocking issues',
    ctx,
  });
  assert.ok(second);
  assert.equal(second.tripwire.kind, 'reviewer_rejections');

  const pass = await guard.onReviewerOutput({
    rootSessionID: 'ses_root',
    parentSessionID: null,
    childSessionID: 'ses_rev_3',
    agent: 'reviewer',
    text: 'Verdict: PASS — 0 blockers',
    ctx,
  });
  assert.equal(pass, null);
  assert.equal(guard.getChainState('ses_root').reviewerRejections, 2);

  assert.equal(isReviewerRejectionText('reviewer', 'Verdict: PASS — 0 blockers'), false);
  assert.equal(isReviewerRejectionText('build', 'VERDICT: FAIL'), false);
});

test('GPT-6.1 Terra is refused immediately in every config/env path', () => {
  assert.throws(
    () => parseModelRef('openrouter/gpt-6.1-terra'),
    /Refusing banned GPT-6\.1 Terra model/,
  );
  assert.throws(
    () => parseModelRef({ providerID: 'openrouter', id: 'gpt-6.1-terra' }),
    /Refusing banned GPT-6\.1 Terra model/,
  );
  assert.throws(
    () => resolveGuardConfig({ decisionModel: 'openrouter/gpt-6.1-terra' }),
    /Refusing banned GPT-6\.1 Terra model/,
  );
  assert.throws(
    () => resolveGuardConfig({ systemOneModel: 'openrouter/gpt-6.1-terra' }),
    /Refusing banned GPT-6\.1 Terra model/,
  );
  assert.throws(
    () => resolveGuardConfig({ fallbackChatModels: ['openrouter/gpt-6.1-terra'] }),
    /Refusing banned GPT-6\.1 Terra model/,
  );
  assert.throws(
    () => createReactiveGuard({ config: { decisionModel: 'openrouter/gpt-6.1-terra' } }),
    /Refusing banned GPT-6\.1 Terra model/,
  );

  // Env-driven decision model.
  const saved = process.env.OPENCODE_WORKFLOW_DECISION_MODEL;
  process.env.OPENCODE_WORKFLOW_DECISION_MODEL = 'openrouter/gpt-6.1-terra';
  try {
    assert.throws(
      () => resolveGuardConfig({}, process.env),
      /Refusing banned GPT-6\.1 Terra model/,
    );
  } finally {
    if (saved === undefined) delete process.env.OPENCODE_WORKFLOW_DECISION_MODEL;
    else process.env.OPENCODE_WORKFLOW_DECISION_MODEL = saved;
  }

  assert.deepEqual(GUARD_ACTIONS, [
    'continue',
    'steer',
    'interrupt_worker',
    'compact',
    'rotate_session',
    'hard_stop',
  ]);
  assert.equal(normalizeErrorSignature('shell', 'X at 2026-01-01T00:00:00Z line 12345'), normalizeErrorSignature('shell', 'x at 2027-02-02T03:04:05Z line 99999'));
});

// ===========================================================================
// 2. LAYER 1 — tiered System-1 judge (all mocked offline)
// ===========================================================================

test('Layer 1A: ctx.experimental.generate.decisions choice answer is used first', async () => {
  const decisionCalls = [];
  const config = resolveGuardConfig({
    decisionModel: { providerID: 'baseten', id: 'baseten/bison-1' },
    judgeTimeoutMs: 200,
  });
  const ctx = {
    experimental: {
      generate: {
        async decisions(request) {
          decisionCalls.push(request);
          return {
            answers: [{ name: 'action', type: 'choice', choice: 'steer', confidence: 0.81 }],
          };
        },
      },
    },
  };

  const decision = await judgeTripwire({
    tripwire: { kind: 'identical_errors', detail: '3x identical error' },
    state: makeJudgeState(),
    chain: makeJudgeChain(),
    ctx,
    config,
    fetchImpl: async () => {
      throw new Error('network must not be used');
    },
  });

  assert.equal(decision.action, 'steer');
  assert.equal(decision.source, 'opencode_decisions');
  assert.equal(decision.confidence, 0.81);
  assert.equal(decisionCalls.length, 1);
  assert.equal(decisionCalls[0].model.id, 'baseten/bison-1');
  assert.equal(decisionCalls[0].questions[0].type, 'choice');
});

test('Layer 1B: OpenRouter /api/v1/systemone choice answer is used when no decision model', async () => {
  const fetchCalls = [];
  const fetchImpl = async (url, init) => {
    fetchCalls.push({ url, init });
    return {
      ok: true,
      async json() {
        return { answers: { action: { choice: 'compact', confidence: 0.92 } } };
      },
    };
  };
  const config = resolveGuardConfig({
    decisionModel: null,
    openrouterApiKey: 'test-key',
    systemOneEnabled: true,
    judgeTimeoutMs: 200,
  });

  const decision = await judgeTripwire({
    tripwire: { kind: 'context_bloat', detail: 'bloat' },
    state: makeJudgeState(),
    chain: makeJudgeChain(),
    ctx: {},
    config,
    fetchImpl,
  });

  assert.equal(decision.action, 'compact');
  assert.equal(decision.source, 'openrouter_systemone');
  assert.equal(decision.confidence, 0.92);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, 'https://openrouter.ai/api/v1/systemone');
  assert.equal(fetchCalls[0].init.headers.authorization, 'Bearer test-key');
  const body = JSON.parse(fetchCalls[0].init.body);
  assert.equal(body.model, '~perplexity/pplx-decider-latest');
  assert.equal(body.state.tripwire.kind, 'context_bloat');
});

test('Layer 1C: generate.text fallback parses JSON and falls back from failing gpt-6-luna to deepseek', async () => {
  const modelCalls = [];
  const config = resolveGuardConfig({
    decisionModel: null,
    openrouterApiKey: '',
    systemOneEnabled: false,
    judgeTimeoutMs: 200,
  });
  const ctx = {
    experimental: {
      generate: {
        async text({ model }) {
          modelCalls.push(`${model.providerID}/${model.id}`);
          if (model.id === 'openai/gpt-6-luna') throw new Error('primary model unavailable');
          return JSON.stringify({
            action: 'rotate_session',
            rationale: 'poisoned loop',
            message: 'Rotating to a clean session.',
          });
        },
      },
    },
  };

  const decision = await judgeTripwire({
    tripwire: { kind: 'context_bloat', detail: 'bloat' },
    state: makeJudgeState(),
    chain: makeJudgeChain(),
    ctx,
    config,
    fetchImpl: async () => {
      throw new Error('network must not be used');
    },
  });

  assert.deepEqual(modelCalls, [
    'openrouter/openai/gpt-6-luna',
    'openrouter/deepseek/deepseek-v4.1-flash-1017',
  ]);
  assert.equal(decision.action, 'rotate_session');
  assert.equal(decision.source, 'opencode_generate_text');
  assert.equal(decision.model, 'openrouter/deepseek/deepseek-v4.1-flash-1017');
  assert.equal(decision.message, 'Rotating to a clean session.');
});

test('Layer 1C: generate.text primary model success is accepted directly', async () => {
  const config = resolveGuardConfig({
    decisionModel: null,
    openrouterApiKey: '',
    systemOneEnabled: false,
    judgeTimeoutMs: 200,
  });
  const ctx = {
    experimental: {
      generate: {
        async text() {
          return '{"action":"steer","rationale":"loop","message":"change approach"}';
        },
      },
    },
  };

  const decision = await judgeTripwire({
    tripwire: { kind: 'worker_spin', detail: 'spin' },
    state: makeJudgeState(),
    chain: makeJudgeChain(),
    ctx,
    config,
  });

  assert.equal(decision.action, 'steer');
  assert.equal(decision.source, 'opencode_generate_text');
  assert.equal(decision.model, 'openrouter/openai/gpt-6-luna');
});

test('Layer 1D: all remote judges failing/malformed falls back deterministically', async () => {
  const config = resolveGuardConfig({
    decisionModel: { providerID: 'baseten', id: 'baseten/bison-1' },
    openrouterApiKey: 'test-key',
    systemOneEnabled: true,
    judgeTimeoutMs: 60,
  });
  const ctx = {
    experimental: {
      generate: {
        async decisions() {
          throw new Error('decisions unavailable');
        },
        async text() {
          return 'I think you should probably compact the context now.';
        },
      },
    },
  };

  const tripwire = { kind: 'identical_errors', detail: '3x identical error' };
  const state = makeJudgeState();
  const chain = makeJudgeChain();
  const decision = await judgeTripwire({
    tripwire,
    state,
    chain,
    ctx,
    config,
    fetchImpl: async () => {
      throw new Error('systemone unreachable');
    },
  });

  const expected = deterministicFallbackDecision(tripwire, state, chain, config);
  assert.equal(decision.action, expected.action);
  assert.equal(decision.source, 'deterministic_fallback');
  assert.equal(decision.action, 'steer');
  assert.match(decision.message, /exact same error 3 times/);
});

test('Layer 1D: judge timeout also falls back deterministically without hanging', async () => {
  const config = resolveGuardConfig({
    decisionModel: null,
    openrouterApiKey: '',
    systemOneEnabled: false,
    judgeTimeoutMs: 25,
    fallbackChatModels: [{ providerID: 'openrouter', id: 'openai/gpt-6-luna' }],
  });
  const ctx = {
    experimental: {
      generate: {
        text() {
          return new Promise(() => {}); // never resolves
        },
      },
    },
  };

  const decision = await judgeTripwire({
    tripwire: { kind: 'worker_spin', detail: 'spin' },
    state: makeJudgeState({ steerCount: 0 }),
    chain: makeJudgeChain(),
    ctx,
    config,
  });

  assert.equal(decision.action, 'steer');
  assert.equal(decision.source, 'deterministic_fallback');
});

// ===========================================================================
// 3. FULL 6-ACTION EXECUTOR + HARD INVARIANTS
// ===========================================================================

test('executor: continue stays quiet but records guard.action', async () => {
  const { guard, ctx, calls, guardActions } = makeGuard({
    judge: async () => ({ action: 'continue', rationale: 'healthy checkpoint' }),
  });
  guard.onPrompt({ sessionID: 'ses_continue', text: 'go', directory: null });

  await guard.onUsageUpdated({ sessionID: 'ses_continue', cost: 4.0, ctx });

  assert.equal(calls.synthetic.length, 0);
  assert.equal(calls.interrupt.length, 0);
  assert.equal(calls.compact.length, 0);
  assert.equal(calls.create.length, 0);
  const actions = guardActions();
  assert.equal(actions.length, 1);
  assert.equal(actions[0].action, 'continue');
  assert.equal(actions[0].tripwire, 'spend_checkpoint');
});

test('executor: steer calls ctx.session.synthetic with delivery=steer, resume=true', async () => {
  const { guard, ctx, calls, guardActions } = makeGuard({
    judge: async () => ({ action: 'steer', rationale: 'loop', message: 'change approach now' }),
  });
  guard.onPrompt({ sessionID: 'ses_steer', text: 'go', directory: null });

  for (let i = 0; i < 3; i += 1) {
    await guard.onToolAfter({
      sessionID: 'ses_steer',
      tool: 'shell',
      status: 'error',
      input: { command: 'npm test' },
      error: 'Error: identical',
      agent: 'build',
      ctx,
    });
  }

  assert.equal(calls.synthetic.length, 1);
  assert.equal(calls.synthetic[0].sessionID, 'ses_steer');
  assert.equal(calls.synthetic[0].delivery, 'steer');
  assert.equal(calls.synthetic[0].resume, true);
  assert.match(calls.synthetic[0].text, /\[Reactive Guard — Steer \(identical_errors\)\]/);
  assert.match(calls.synthetic[0].text, /change approach now/);
  assert.equal(guard.getSessionState('ses_steer').steerCount, 1);
  assert.equal(guardActions()[0].action, 'steer');
});

test('executor: interrupt_worker on a child interrupts it, writes Blackboard report with git status, and reports to parent', async (t) => {
  const dir = makeTempDir(t);
  initGitRepo(dir);
  const bbReports = [];
  const blackboard = {
    buildPointerBlock: () => 'SHARED-BB-POINTER',
    recordSubagentReport(args) {
      bbReports.push(args);
      return { validation: { valid: true }, report: { path: '/tmp/report.md' } };
    },
  };
  const { guard, ctx, calls, guardActions } = makeGuard({
    blackboard,
    judge: async () => ({ action: 'interrupt_worker', rationale: 'child stuck' }),
  });

  guard.onPrompt({ sessionID: 'ses_root', text: 'delegate', directory: dir });
  guard.onSubagentSpawn({
    parentSessionID: 'ses_root',
    childSessionID: 'ses_child',
    agent: 'worker',
    directory: dir,
  });

  for (let i = 0; i < 17; i += 1) {
    await guard.onToolAfter({
      sessionID: 'ses_child',
      tool: 'read',
      status: 'completed',
      input: { path: '/p/child-same.js' },
      agent: 'worker',
      ctx,
    });
  }

  assert.equal(calls.interrupt.length, 1);
  assert.deepEqual(calls.interrupt[0], { sessionID: 'ses_child', resume: false });
  assert.equal(bbReports.length, 1);
  assert.equal(bbReports[0].status, 'interrupted');
  assert.match(bbReports[0].text, /Workspace git status --short:/);
  assert.match(bbReports[0].text, /work\.txt/);
  assert.equal(calls.synthetic.length, 1);
  assert.equal(calls.synthetic[0].sessionID, 'ses_root');
  assert.equal(calls.synthetic[0].delivery, 'queue');
  assert.equal(calls.synthetic[0].resume, true);
  assert.match(calls.synthetic[0].text, /ses_child/);
  assert.equal(guardActions()[0].action, 'interrupt_worker');
});

test('invariant: interrupt_worker on a ROOT session maps to steer or hard_stop (never interrupts root as worker)', () => {
  const config = resolveGuardConfig({});
  const tripwire = { kind: 'worker_spin', detail: 'spin' };
  const chain = makeJudgeChain();

  const steer = normalizeGuardDecision(
    { action: 'interrupt_worker', rationale: 'stuck' },
    { tripwire, state: makeJudgeState({ isChild: false, steerCount: 0 }), chain, config },
  );
  assert.equal(steer.action, 'steer');

  const stop = normalizeGuardDecision(
    { action: 'interrupt_worker', rationale: 'stuck' },
    { tripwire, state: makeJudgeState({ isChild: false, steerCount: 2 }), chain, config },
  );
  assert.equal(stop.action, 'hard_stop');
  assert.match(stop.rationale, /mapped interrupt_worker -> hard_stop/);
});

test('executor: compact calls ctx.session.compact with queue delivery', async () => {
  const { guard, ctx, calls, guardActions } = makeGuard({
    judge: async () => ({ action: 'compact', rationale: 'bloat', message: 'compact now' }),
  });
  guard.onPrompt({ sessionID: 'ses_compact', text: 'go', directory: null });

  await guard.onUsageUpdated({ sessionID: 'ses_compact', tokens: { input: 50_000 }, ctx });
  await guard.onUsageUpdated({ sessionID: 'ses_compact', tokens: { input: 190_000 }, ctx });

  assert.equal(calls.compact.length, 1);
  assert.deepEqual(calls.compact[0], { sessionID: 'ses_compact', delivery: 'queue' });
  assert.equal(calls.interrupt.length, 0);
  assert.equal(guardActions()[0].action, 'compact');
});

test('executor: rotate_session interrupts old, creates new, writes visible handoff, prompts new session with goal+MEMORY+git+Blackboard', async (t) => {
  const dir = makeTempDir(t);
  initGitRepo(dir);
  fs.writeFileSync(path.join(dir, 'MEMORY.md'), '# Memory\n\nMEMORY-MARKER: keep the widget build green.\n');

  const blackboard = {
    buildPointerBlock: (rootSessionID) => `SHARED-BB-POINTER:${rootSessionID}`,
  };
  const { guard, ctx, calls, guardActions } = makeGuard({
    blackboard,
    createIds: ['ses_new'],
    judge: async () => ({ action: 'rotate_session', rationale: 'post-compaction bloat', message: 'rotate' }),
  });

  guard.onPrompt({ sessionID: 'ses_old', text: 'Build the widget', directory: dir });
  guard.onSessionContext({
    sessionID: 'ses_old',
    agent: 'build',
    model: { providerID: 'openrouter', id: 'deepseek/deepseek-v4.1-flash-1017' },
    directory: dir,
  });

  await guard.onUsageUpdated({ sessionID: 'ses_old', tokens: { input: 50_000 }, ctx });
  await guard.onUsageUpdated({ sessionID: 'ses_old', tokens: { input: 190_000 }, ctx });

  assert.equal(calls.interrupt.length, 1);
  assert.deepEqual(calls.interrupt[0], { sessionID: 'ses_old', resume: false });

  assert.equal(calls.create.length, 1);
  assert.equal(calls.create[0].agent, 'build');
  assert.equal(calls.create[0].model.id, 'deepseek/deepseek-v4.1-flash-1017');
  assert.equal(calls.create[0].location.directory, dir);
  assert.equal(calls.create[0].metadata.rotatedFrom, 'ses_old');

  assert.equal(calls.synthetic.length, 1);
  assert.equal(calls.synthetic[0].sessionID, 'ses_old');
  assert.equal(calls.synthetic[0].resume, false);
  assert.match(calls.synthetic[0].text, /Session Rotated \(1\/2\)/);
  assert.match(calls.synthetic[0].text, /ses_new/);

  assert.equal(calls.prompt.length, 1);
  assert.equal(calls.prompt[0].sessionID, 'ses_new');
  const handoff = calls.prompt[0].text;
  assert.match(handoff, /Automatic Session Rotation 1\/2/);
  assert.match(handoff, /Build the widget/);
  assert.match(handoff, /MEMORY-MARKER: keep the widget build green\./);
  assert.match(handoff, /## Current Workspace `git status --short`/);
  assert.match(handoff, /work\.txt/);
  assert.match(handoff, /SHARED-BB-POINTER:ses_old/);

  const chain = guard.getChainState('ses_old');
  assert.equal(chain.rotationCount, 1);
  assert.equal(chain.totalSpendUsd, 0);
  assert.equal(guard.getSessionState('ses_old').rotatedTo, 'ses_new');
  assert.equal(guardActions()[0].action, 'rotate_session');

  // Shared cumulative chain spend: spend on the ROTATED session trips the SAME $15 fuse.
  const judgeBefore = guardActions().length;
  await guard.onUsageUpdated({ sessionID: 'ses_new', cost: 15.0, ctx });
  assert.equal(chain.totalSpendUsd, 15);
  assert.equal(guard.getSessionState('ses_new').stopped, true);
  const actions = guardActions();
  assert.equal(actions.length, judgeBefore + 1);
  assert.equal(actions.at(-1).sessionID, 'ses_new');
  assert.equal(actions.at(-1).tripwire, 'hard_spend_fuse');
  assert.equal(actions.at(-1).action, 'hard_stop');
});

test('invariant: max-2 rotation chain cap maps 3rd rotation request to compact (bloat) / hard_stop (spin)', async () => {
  const config = resolveGuardConfig({});
  const rootState = makeJudgeState({ isChild: false });
  const cappedChain = makeJudgeChain({ rotationCount: 2 });

  const bloat = normalizeGuardDecision(
    { action: 'rotate_session', rationale: 'bloat' },
    { tripwire: { kind: 'context_bloat', detail: 'bloat' }, state: rootState, chain: cappedChain, config },
  );
  assert.equal(bloat.action, 'compact');

  const spin = normalizeGuardDecision(
    { action: 'rotate_session', rationale: 'spin' },
    { tripwire: { kind: 'worker_spin', detail: 'spin' }, state: rootState, chain: cappedChain, config },
  );
  assert.equal(spin.action, 'hard_stop');

  const childRotate = normalizeGuardDecision(
    { action: 'rotate_session', rationale: 'child' },
    {
      tripwire: { kind: 'context_bloat', detail: 'bloat' },
      state: makeJudgeState({ isChild: true }),
      chain: makeJudgeChain(),
      config,
    },
  );
  assert.equal(childRotate.action, 'interrupt_worker');

  // End-to-end: two real rotations succeed, the third request compacts instead of creating.
  const { guard, ctx, calls } = makeGuard({
    createIds: ['ses_r1', 'ses_r2'],
    judge: async () => ({ action: 'rotate_session', rationale: 'bloat' }),
  });
  guard.onPrompt({ sessionID: 'ses_root', text: 'long task', directory: null });

  for (const sessionID of ['ses_root', 'ses_r1', 'ses_r2']) {
    await guard.onUsageUpdated({ sessionID, tokens: { input: 50_000 }, ctx });
    await guard.onUsageUpdated({ sessionID, tokens: { input: 190_000 }, ctx });
  }

  assert.equal(calls.create.length, 2, 'only two rotations may ever be created');
  assert.equal(calls.compact.length, 1, 'third rotation request must compact');
  assert.equal(calls.compact[0].sessionID, 'ses_r2');
  assert.equal(guard.getChainState('ses_root').rotationCount, 2);
});

test('executor: hard_stop interrupts and writes a visible resume:false alert', async () => {
  const { guard, ctx, calls, guardActions } = makeGuard({
    judge: async () => ({ action: 'continue' }), // judge output must be overridden by the fuse
  });
  guard.onPrompt({ sessionID: 'ses_stop', text: 'stop', directory: null });

  await guard.onUsageUpdated({ sessionID: 'ses_stop', cost: 15.0, ctx });

  assert.equal(calls.interrupt.length, 1);
  assert.deepEqual(calls.interrupt[0], { sessionID: 'ses_stop', resume: false });
  assert.equal(calls.synthetic.length, 1);
  assert.equal(calls.synthetic[0].delivery, 'queue');
  assert.equal(calls.synthetic[0].resume, false);
  assert.match(calls.synthetic[0].text, /HARD STOP \(hard_spend_fuse\)/);
  assert.equal(guardActions()[0].action, 'hard_stop');
});

test('buildRotationHandoffPrompt includes goal, bounded MEMORY.md, git status, and Blackboard pointer', (t) => {
  const dir = makeTempDir(t);
  initGitRepo(dir);
  fs.writeFileSync(path.join(dir, 'MEMORY.md'), '# Memory\n\nBOUNDED-MEMORY\n');

  const prompt = buildRotationHandoffPrompt({
    chain: {
      goal: 'Preserve this goal',
      rotationCount: 1,
      maxRotationChain: 2,
      totalSpendUsd: 3.5,
      spendFuseUsd: 15,
      rootSessionID: 'ses_root',
    },
    oldSessionID: 'ses_old',
    reason: 'test reason',
    directory: dir,
    blackboard: { buildPointerBlock: () => 'BB-POINTER' },
  });

  assert.match(prompt, /Automatic Session Rotation 2\/2/);
  assert.match(prompt, /Preserve this goal/);
  assert.match(prompt, /BOUNDED-MEMORY/);
  assert.match(prompt, /git status --short/);
  assert.match(prompt, /BB-POINTER/);
  assert.match(prompt, /\$3\.50 \/ \$15\.00 hard fuse/);
});

// ===========================================================================
// 4. LAYER 2 — automatic MEMORY.md refresh
// ===========================================================================

test('memory refresh: refreshes MEMORY.md atomically with .bak, <= 2500 chars, on meaningful root idle', async (t) => {
  const dir = makeTempDir(t);
  fs.writeFileSync(path.join(dir, 'package.json'), '{}');
  fs.writeFileSync(path.join(dir, 'MEMORY.md'), 'OLD CONTENT');
  const auditDir = path.join(dir, 'audit');
  fs.mkdirSync(auditDir);

  let now = 1_000_000;
  const records = [];
  const llm = async () => '# Project Memory\n\n- NEW MEMORY ENTRY\n';
  const refresher = createMemoryRefresher({
    llm,
    clock: () => now,
    auditDir,
    dbPath: false,
    record: (event, data) => records.push({ event, data }),
  });

  const first = await refresher.maybeRefreshOnIdle({
    sessionID: 'ses_mem',
    isChild: false,
    directory: dir,
    toolCalls: 4,
    fileMutations: 0,
    ctx: {},
  });

  assert.equal(first.refreshed, true);
  assert.equal(first.result.written, true);
  assert.equal(first.result.status, 'llm');
  assert.ok(first.result.characters <= 2500);

  const memoryPath = path.join(dir, 'MEMORY.md');
  const content = fs.readFileSync(memoryPath, 'utf8');
  assert.match(content, /NEW MEMORY ENTRY/);
  assert.ok(Array.from(content).length <= 2500);
  assert.equal(fs.readFileSync(`${memoryPath}.bak`, 'utf8'), 'OLD CONTENT');
  assert.equal(records.filter((entry) => entry.event === 'memory.refresh.completed').length, 1);

  // Cooldown: second idle inside the window is skipped.
  const second = await refresher.maybeRefreshOnIdle({
    sessionID: 'ses_mem',
    isChild: false,
    directory: dir,
    toolCalls: 10,
    fileMutations: 3,
    ctx: {},
  });
  assert.equal(second.refreshed, false);
  assert.equal(second.reason, 'cooldown');

  // Past the cooldown it refreshes again.
  now += refresher.config.cooldownMs;
  const third = await refresher.maybeRefreshOnIdle({
    sessionID: 'ses_mem',
    isChild: false,
    directory: dir,
    toolCalls: 10,
    fileMutations: 3,
    ctx: {},
  });
  assert.equal(third.refreshed, true);
});

test('memory refresh: file mutations alone qualify as meaningful work', async (t) => {
  const dir = makeTempDir(t);
  fs.writeFileSync(path.join(dir, 'package.json'), '{}');
  const refresher = createMemoryRefresher({
    llm: async () => '# M\n\n- mutation driven\n',
    clock: () => 2_000_000,
    dbPath: false,
  });

  const result = await refresher.maybeRefreshOnIdle({
    sessionID: 'ses_mut',
    isChild: false,
    directory: dir,
    toolCalls: 0,
    fileMutations: 1,
    ctx: {},
  });
  assert.equal(result.refreshed, true);
  assert.match(fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8'), /mutation driven/);
});

test('memory refresh: oversized model output is deterministically truncated to <= 2500 chars', async (t) => {
  const dir = makeTempDir(t);
  fs.writeFileSync(path.join(dir, 'package.json'), '{}');
  const refresher = createMemoryRefresher({
    llm: async () => 'A'.repeat(5_000),
    clock: () => 3_000_000,
    dbPath: false,
  });

  const result = await refresher.maybeRefreshOnIdle({
    sessionID: 'ses_long',
    isChild: false,
    directory: dir,
    toolCalls: 5,
    fileMutations: 0,
    ctx: {},
  });

  assert.equal(result.refreshed, true);
  assert.equal(result.result.status, 'truncated');
  assert.ok(result.result.characters <= 2500);
  assert.ok(Array.from(fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8')).length <= 2500);
});

test('memory refresh: skips child sessions, ephemeral/forbidden dirs, and below-threshold work', async (t) => {
  const dir = makeTempDir(t);
  fs.writeFileSync(path.join(dir, 'package.json'), '{}');
  const refresher = createMemoryRefresher({
    llm: async () => '# M\n\n- should not matter\n',
    clock: () => 4_000_000,
    dbPath: false,
  });

  const child = await refresher.maybeRefreshOnIdle({
    sessionID: 'ses_child',
    isChild: true,
    directory: dir,
    toolCalls: 100,
    fileMutations: 10,
    ctx: {},
  });
  assert.equal(child.reason, 'child_session');

  for (const directory of [
    '/root/.config/openchamber/chats/some-chat',
    '/root/.pi',
    '/root/pi-projects/pi-workflow-tools',
    '/root/pi-projects/pi-workflow-tools/sub',
    '/',
  ]) {
    const result = await refresher.maybeRefreshOnIdle({
      sessionID: 'ses_x',
      isChild: false,
      directory,
      toolCalls: 100,
      fileMutations: 10,
      ctx: {},
    });
    assert.equal(result.reason, 'ineligible_workspace', `expected ineligible for ${directory}`);
  }

  const below = await refresher.maybeRefreshOnIdle({
    sessionID: 'ses_below',
    isChild: false,
    directory: dir,
    toolCalls: 3,
    fileMutations: 0,
    ctx: {},
  });
  assert.equal(below.reason, 'below_meaningful_work_threshold');

  assert.equal(isEligibleMemoryWorkspace(dir), true);
  assert.equal(isEligibleMemoryWorkspace('/root/.pi'), false);
  assert.equal(isEligibleMemoryWorkspace('/root/.config/openchamber/chats/abc'), false);
  assert.equal(isEligibleMemoryWorkspace('/definitely/not/a/real/dir'), false);
});

// ===========================================================================
// 5. WEEKLY RSI NATIVE AUTOMATION HELPER
// ===========================================================================

test('rsi-schedule: builds a valid weekly cron + read-only shell automation spec', (t) => {
  const dir = makeTempDir(t);
  const outPath = path.join(dir, 'rsi-latest.txt');
  const spec = buildWeeklyRsiAutomationSpec({ repoRoot: REPO_ROOT, outPath });

  assert.equal(spec.name, WEEKLY_RSI_AUTOMATION_NAME);
  assert.equal(spec.trigger.type, 'cron');
  assert.equal(spec.trigger.cron, WEEKLY_RSI_CRON);
  assert.equal(spec.trigger.tz, DEFAULT_RSI_TZ);

  const fields = spec.trigger.cron.split(/\s+/);
  assert.equal(fields.length, 5);
  assert.deepEqual(fields, ['0', '9', '*', '*', '1']);

  assert.equal(spec.action.type, 'shell');
  const command = spec.action.command;
  assert.ok(command.startsWith('node '), 'command must run node');
  assert.ok(command.includes(path.join('src', 'rsi-prune.mjs')), 'command must run rsi-prune');
  assert.ok(command.includes('--days 7'));
  assert.ok(command.includes(path.resolve(outPath)));
  assert.equal(command.includes('--days 7 --out'), true);
  assert.equal(/rm\s|mv\s|>\s*\/|config\//.test(command), false, 'must be read-only');

  // Days validation / resolution behaviour.
  assert.ok(buildWeeklyRsiAutomationSpec({ days: 0 }).action.command.includes('--days 7'));
  assert.ok(buildWeeklyRsiAutomationSpec({ days: '14' }).action.command.includes('--days 14'));
  assert.ok(
    buildWeeklyRsiAutomationSpec({ outPath: 'relative/report.txt' }).action.command.includes(
      path.resolve('relative/report.txt'),
    ),
  );
});

test('rsi-schedule: ensureWeeklyRsiAutomation creates once and is idempotent', async (t) => {
  const dir = makeTempDir(t);
  const outPath = path.join(dir, 'rsi-latest.txt');
  const created = [];
  const automationApi = {
    async list() {
      return created;
    },
    async create(spec) {
      const automation = { ...spec, id: `aut_${created.length + 1}`, status: 'active' };
      created.push(automation);
      return automation;
    },
  };

  const first = await ensureWeeklyRsiAutomation(automationApi, { repoRoot: REPO_ROOT, outPath });
  assert.equal(first.created, true);
  assert.equal(created.length, 1);
  assert.equal(first.automation.name, WEEKLY_RSI_AUTOMATION_NAME);

  const second = await ensureWeeklyRsiAutomation(automationApi, { repoRoot: REPO_ROOT, outPath });
  assert.equal(second.created, false);
  assert.equal(created.length, 1, 'must not duplicate the weekly automation');
  assert.equal(second.automation.id, 'aut_1');

  // Tolerates the `{ automations: [...] }` list shape.
  const wrapped = {
    async list() {
      return { automations: created };
    },
    async create() {
      throw new Error('must not create');
    },
  };
  const third = await ensureWeeklyRsiAutomation(wrapped, { repoRoot: REPO_ROOT, outPath });
  assert.equal(third.created, false);

  await assert.rejects(() => ensureWeeklyRsiAutomation(null), /must expose list\(\) and create\(\)/);
});

// ===========================================================================
// 6. END-TO-END PLUGIN HOOK FLOWS
// ===========================================================================

test('E2E plugin: session.prompt -> 3 identical tool errors -> steer synthetic + guard.action audit record', async (t) => {
  resetSharedBusForTests();
  const root = makeTempDir(t);
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  const auditDir = path.join(root, 'audit');
  const blackboardDir = path.join(root, 'bb');
  useEnv(t, { [AUDIT_DIR_ENV]: auditDir, [BLACKBOARD_DIR_ENV]: blackboardDir });

  const syntheticCalls = [];
  const judgeCalls = [];
  const mock = createMockContext({
    directory: project,
    options: {
      guard: {
        config: { judgeCooldownMs: 0 },
        judge: async (args) => {
          judgeCalls.push(args);
          return {
            action: 'steer',
            rationale: 'same error repeated',
            message: 'stop repeating the same failing command',
          };
        },
      },
    },
    session: {
      async synthetic(args) {
        syntheticCalls.push(args);
      },
    },
  });

  const cleanup = await auditPlugin.setup(mock.ctx);
  t.after(() => cleanup());

  await mock.call('session.prompt', {
    sessionID: 'ses_e2e',
    prompt: { text: 'Fix the failing build' },
  });

  for (let i = 0; i < 3; i += 1) {
    await mock.call('tool.execute.after', {
      id: `call_${i}`,
      tool: 'shell',
      sessionID: 'ses_e2e',
      agent: 'build',
      status: 'error',
      input: { command: 'npm test' },
      error: 'Error: same failure',
    });
  }

  assert.equal(judgeCalls.length, 1, 'only the third identical error should trip the judge');
  assert.equal(judgeCalls[0].tripwire.kind, 'identical_errors');
  assert.equal(syntheticCalls.length, 1);
  assert.equal(syntheticCalls[0].sessionID, 'ses_e2e');
  assert.equal(syntheticCalls[0].delivery, 'steer');
  assert.equal(syntheticCalls[0].resume, true);
  assert.match(syntheticCalls[0].text, /stop repeating the same failing command/);

  const entries = readAllJsonl(auditDir);
  const guardActions = entries.filter((entry) => entry.event === 'guard.action');
  assert.equal(guardActions.length, 1);
  assert.equal(guardActions[0].sessionID, 'ses_e2e');
  assert.equal(guardActions[0].action, 'steer');
  assert.equal(guardActions[0].tripwire, 'identical_errors');
  assert.equal(guardActions[0].ok, true);
  assert.ok(entries.some((entry) => entry.event === 'session.prompt'));
  assert.ok(entries.some((entry) => entry.event === 'tool.after'));
});

test('E2E plugin: root experimental.idle with syncMemoryRefresh updates MEMORY.md', async (t) => {
  resetSharedBusForTests();
  const root = makeTempDir(t);
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'package.json'), '{}');
  const auditDir = path.join(root, 'audit');
  const blackboardDir = path.join(root, 'bb');
  useEnv(t, { [AUDIT_DIR_ENV]: auditDir, [BLACKBOARD_DIR_ENV]: blackboardDir });

  const memoryText = '# Project Memory\n\n- Wave 2 memory refresh e2e\n';
  const mock = createMockContext({
    directory: project,
    options: {
      syncMemoryRefresh: true,
      memoryRefresh: {
        llm: async () => memoryText,
      },
    },
  });

  const cleanup = await auditPlugin.setup(mock.ctx);
  t.after(() => cleanup());

  await mock.call('session.prompt', {
    sessionID: 'ses_mem_e2e',
    prompt: { text: 'Work on the project' },
  });

  for (let i = 0; i < 4; i += 1) {
    await mock.call('tool.execute.after', {
      id: `read_${i}`,
      tool: 'read',
      sessionID: 'ses_mem_e2e',
      agent: 'build',
      status: 'completed',
      input: { path: `/p/file-${i}.js` },
    });
  }

  await mock.call('session.experimental.idle', { sessionID: 'ses_mem_e2e' });

  const memoryPath = path.join(project, 'MEMORY.md');
  assert.ok(fs.existsSync(memoryPath), 'MEMORY.md should be created on idle');
  const content = fs.readFileSync(memoryPath, 'utf8');
  assert.match(content, /Wave 2 memory refresh e2e/);
  assert.ok(Array.from(content).length <= 2500);

  const entries = readAllJsonl(auditDir);
  assert.ok(entries.some((entry) => entry.event === 'memory.refresh.completed'));
});

// ===========================================================================
// 7. WAVE 2 BLOCKER REGRESSIONS (B1-B7)
// ===========================================================================

async function tripRotation(guard, ctx, sessionID) {
  await guard.onUsageUpdated({ sessionID, tokens: { input: 50_000 }, ctx });
  await guard.onUsageUpdated({ sessionID, tokens: { input: 190_000 }, ctx });
}

test('B1: rotate_session create failure leaves the old session running, records ok:false, and posts a visible notice', async () => {
  const { guard, ctx, calls, guardActions } = makeGuard({
    judge: async () => ({ action: 'rotate_session', rationale: 'post-compaction bloat' }),
  });
  guard.onPrompt({ sessionID: 'ses_old_create', text: 'goal', directory: null });
  ctx.session.create = async () => {
    throw new Error('create exploded');
  };

  await tripRotation(guard, ctx, 'ses_old_create');

  assert.equal(calls.interrupt.length, 0, 'old session must NOT be interrupted');
  assert.equal(calls.prompt.length, 0);
  const state = guard.getSessionState('ses_old_create');
  assert.equal(state.stopped, false);
  assert.equal(state.rotatedTo, null);
  assert.equal(guard.getChainState('ses_old_create').rotationCount, 0);

  const actions = guardActions();
  assert.equal(actions.length, 1);
  assert.equal(actions[0].action, 'rotate_session');
  assert.equal(actions[0].ok, false);
  assert.match(actions[0].error, /create exploded/);

  assert.equal(calls.synthetic.length, 1, 'failure must be visible to the human');
  assert.equal(calls.synthetic[0].sessionID, 'ses_old_create');
  assert.equal(calls.synthetic[0].resume, false);
  assert.equal(calls.synthetic[0].delivery, 'queue');
  assert.match(calls.synthetic[0].text, /rotation failed/i);
  assert.equal(calls.synthetic[0].metadata.ok, false);
});

test('B1: rotate_session prompt failure stops only the new session, keeps rotationCount at 0 and old session running', async () => {
  const { guard, ctx, calls, guardActions } = makeGuard({
    judge: async () => ({ action: 'rotate_session', rationale: 'poisoned loop' }),
  });
  guard.onPrompt({ sessionID: 'ses_old_prompt', text: 'goal', directory: null });
  ctx.session.prompt = async () => {
    throw new Error('prompt exploded');
  };

  await tripRotation(guard, ctx, 'ses_old_prompt');

  const oldInterrupts = calls.interrupt.filter((call) => call.sessionID === 'ses_old_prompt');
  assert.equal(oldInterrupts.length, 0, 'old session must NOT be interrupted when prompt fails');
  assert.equal(calls.create.length, 1);
  assert.equal(calls.prompt.length, 0, 'the throwing prompt call is recorded only on failure');

  const state = guard.getSessionState('ses_old_prompt');
  assert.equal(state.stopped, false);
  assert.equal(state.rotatedTo, null);
  assert.equal(guard.getChainState('ses_old_prompt').rotationCount, 0);

  const actions = guardActions();
  assert.equal(actions.length, 1);
  assert.equal(actions[0].ok, false);
  assert.match(actions[0].error, /prompt exploded/);
  assert.ok(
    calls.synthetic.some((call) => call.sessionID === 'ses_old_prompt' && /rotation failed/i.test(call.text)),
    'old chat receives a visible failure notice',
  );
});

test('B1: a failing old-chat handoff pointer never fails an otherwise completed rotation', async () => {
  const { guard, ctx, calls, guardActions } = makeGuard({
    createIds: ['ses_new_pointer'],
    judge: async () => ({ action: 'rotate_session', rationale: 'bloat' }),
  });
  guard.onPrompt({ sessionID: 'ses_old_pointer', text: 'goal', directory: null });
  ctx.session.synthetic = async () => {
    throw new Error('synthetic exploded');
  };

  await tripRotation(guard, ctx, 'ses_old_pointer');

  assert.equal(calls.create.length, 1);
  assert.equal(calls.prompt.length, 1);
  assert.equal(calls.prompt[0].sessionID, 'ses_new_pointer');
  assert.deepEqual(calls.interrupt.find((call) => call.sessionID === 'ses_old_pointer'), {
    sessionID: 'ses_old_pointer',
    resume: false,
  });

  const state = guard.getSessionState('ses_old_pointer');
  assert.equal(state.rotatedTo, 'ses_new_pointer');
  assert.equal(state.stopped, true);
  assert.equal(guard.getChainState('ses_old_pointer').rotationCount, 1);
  const actions = guardActions();
  assert.equal(actions[0].ok, true);
  assert.equal(actions[0].newSessionID, 'ses_new_pointer');
});

test('B1+B4: a banned Terra session model is refused BEFORE the old session is interrupted or a new one created', async () => {
  const { guard, ctx, calls, guardActions } = makeGuard({
    judge: async () => ({ action: 'rotate_session', rationale: 'bloat' }),
  });
  guard.onPrompt({ sessionID: 'ses_old_terra', text: 'goal', directory: null });
  guard.onSessionContext({
    sessionID: 'ses_old_terra',
    agent: 'build',
    model: { providerID: 'openrouter', id: 'openai/gpt-6.1-terra' },
    directory: null,
  });

  await tripRotation(guard, ctx, 'ses_old_terra');

  assert.equal(calls.interrupt.length, 0);
  assert.equal(calls.create.length, 0);
  assert.equal(calls.prompt.length, 0);
  const state = guard.getSessionState('ses_old_terra');
  assert.equal(state.stopped, false);
  assert.equal(state.rotatedTo, null);
  assert.equal(guard.getChainState('ses_old_terra').rotationCount, 0);
  const actions = guardActions();
  assert.equal(actions[0].ok, false);
  assert.match(actions[0].error, /Refusing banned GPT-6\.1 Terra model/);
});

test('B3: null/undefined/blank/NaN/negative/boolean cost is ignored and only monotonic increases add spend', async () => {
  const { guard, ctx } = makeGuard({ judge: async () => ({ action: 'continue' }) });
  guard.onPrompt({ sessionID: 'ses_cost', text: 'spend', directory: null });

  for (const cost of [null, undefined, '', '   ', NaN, -1, true, false, Infinity, -Infinity]) {
    await guard.onUsageUpdated({ sessionID: 'ses_cost', cost, ctx });
  }
  assert.equal(guard.getChainState('ses_cost').totalSpendUsd, 0);
  assert.equal(guard.getSessionState('ses_cost').prevCumulativeCostUsd, 0);

  await guard.onUsageUpdated({ sessionID: 'ses_cost', cost: 5.0, ctx });
  assert.equal(guard.getChainState('ses_cost').totalSpendUsd, 5);
  await guard.onUsageUpdated({ sessionID: 'ses_cost', cost: 4.99, ctx });
  assert.equal(guard.getChainState('ses_cost').totalSpendUsd, 5, 'a decrease must not add spend');
  await guard.onUsageUpdated({ sessionID: 'ses_cost', cost: 5.2, ctx });
  assert.equal(guard.getChainState('ses_cost').totalSpendUsd, 5.2);
  assert.equal(guard.getSessionState('ses_cost').prevCumulativeCostUsd, 5.2);
});

test('B3: late usage from a stopped child and a rotated-away session still counts toward chain spend', async () => {
  const { guard, ctx } = makeGuard({ judge: async () => ({ action: 'continue' }) });
  guard.onPrompt({ sessionID: 'ses_root_late', text: 'root', directory: null });
  guard.onSubagentSpawn({
    parentSessionID: 'ses_root_late',
    childSessionID: 'ses_child_late',
    agent: 'worker',
    directory: null,
  });

  await guard.onUsageUpdated({ sessionID: 'ses_child_late', cost: 16, ctx });
  const chain = guard.getChainState('ses_root_late');
  assert.equal(chain.totalSpendUsd, 16);
  assert.equal(guard.getSessionState('ses_child_late').stopped, true);

  await guard.onUsageUpdated({ sessionID: 'ses_child_late', cost: 20, ctx });
  assert.equal(chain.totalSpendUsd, 20, 'stopped children keep billing and must be counted');

  const rotated = makeGuard({
    createIds: ['ses_rotated_late'],
    judge: async () => ({ action: 'rotate_session', rationale: 'bloat' }),
  });
  rotated.guard.onPrompt({ sessionID: 'ses_rot_late', text: 'rot', directory: null });
  await tripRotation(rotated.guard, rotated.ctx, 'ses_rot_late');
  assert.equal(rotated.guard.getSessionState('ses_rot_late').rotatedTo, 'ses_rotated_late');

  const rotatedChain = rotated.guard.getChainState('ses_rot_late');
  const before = rotatedChain.totalSpendUsd;
  await rotated.guard.onUsageUpdated({ sessionID: 'ses_rot_late', cost: 2.5, ctx: rotated.ctx });
  assert.equal(rotatedChain.totalSpendUsd, before + 2.5, 'rotated-away sessions keep billing');
});

test('B2: 20 path-less apply_patch mutations and 20 distinct build-agent reads are healthy (0 judge calls)', async () => {
  const patchSpy = judgeSpy(() => ({ action: 'continue' }));
  const patched = makeGuard({ judge: patchSpy.fn });
  patched.guard.onPrompt({ sessionID: 'ses_patch_healthy', text: 'patch', directory: null });
  for (let i = 0; i < 20; i += 1) {
    await patched.guard.onToolAfter({
      sessionID: 'ses_patch_healthy',
      tool: 'apply_patch',
      status: 'completed',
      input: { patchText: `*** Begin Patch\n*** Update File: /p/patch-${i}.js\n@@\n-old\n+new ${i}\n*** End Patch` },
      agent: 'build',
      ctx: patched.ctx,
    });
  }
  assert.equal(patchSpy.calls.length, 0, 'apply_patch without `path` must still count as progress');
  const patchState = patched.guard.getSessionState('ses_patch_healthy');
  assert.equal(patchState.steps, 20);
  assert.equal(patchState.lastProgressStep, 20);
  assert.equal(patchState.recentEdits.at(-1).file, '/p/patch-19.js');

  const readSpy = judgeSpy(() => ({ action: 'continue' }));
  const read = makeGuard({ judge: readSpy.fn });
  read.guard.onPrompt({ sessionID: 'ses_build_reads', text: 'explore', directory: null });
  for (let i = 0; i < 20; i += 1) {
    await read.guard.onToolAfter({
      sessionID: 'ses_build_reads',
      tool: 'read',
      status: 'completed',
      input: { path: `/p/build-distinct-${i}.js` },
      agent: 'build',
      ctx: read.ctx,
    });
  }
  assert.equal(readSpy.calls.length, 0, 'distinct reads by a build agent are forward progress');
  assert.equal(read.guard.getSessionState('ses_build_reads').lastProgressStep, 20);
});

test('B2: repeating the SAME build-agent read target 16 times trips worker_spin, and continue resets the window', async () => {
  const spy = judgeSpy(() => ({ action: 'continue' }));
  const { guard, ctx, advance } = makeGuard({
    judge: spy.fn,
    config: { judgeCooldownMs: 30_000 },
  });
  guard.onPrompt({ sessionID: 'ses_repeat_build', text: 'spin', directory: null });

  // One discovery + 16 identical repeats with no new target.
  for (let i = 0; i < 17; i += 1) {
    await guard.onToolAfter({
      sessionID: 'ses_repeat_build',
      tool: 'read',
      status: 'completed',
      input: { path: '/p/same-build.js' },
      agent: 'build',
      ctx,
    });
  }
  assert.equal(spy.calls.length, 1);
  assert.equal(spy.calls[0].tripwire.kind, 'worker_spin');
  assert.match(spy.calls[0].tripwire.detail, /16 tool steps without file\/verification progress/);

  const state = guard.getSessionState('ses_repeat_build');
  assert.equal(state.lastProgressStep, state.steps, 'continue must clear the spin watermark');

  advance(60_000);
  for (let i = 0; i < 5; i += 1) {
    await guard.onToolAfter({
      sessionID: 'ses_repeat_build',
      tool: 'read',
      status: 'completed',
      input: { path: '/p/same-build.js' },
      agent: 'build',
      ctx,
    });
  }
  assert.equal(spy.calls.length, 1, 'a continue verdict must not re-trip on stale state');
});

test('reviewer detection: PASS reports with fail-ish headings or zero blockers are not rejections', () => {
  assert.equal(isReviewerRejectionText('reviewer', '## Fail-open analysis\n\nThe guard is fail-open by design.'), false);
  assert.equal(isReviewerRejectionText('reviewer', '## Fail-open analysis\n\nBlocking findings: none'), false);
  assert.equal(isReviewerRejectionText('reviewer', 'Blocking findings: none'), false);
  assert.equal(isReviewerRejectionText('reviewer', 'Blocking issues: 0'), false);
  assert.equal(isReviewerRejectionText('reviewer', '0 blocking'), false);

  assert.equal(isReviewerRejectionText('reviewer', 'VERDICT: FAIL'), true);
  assert.equal(isReviewerRejectionText('reviewer', 'Verdict: **FAIL**'), true);
  assert.equal(isReviewerRejectionText('reviewer', '- 3 blocking findings'), true);
  assert.equal(isReviewerRejectionText('reviewer', '- 2 blocking issues'), true);
  assert.equal(isReviewerRejectionText('reviewer', 'Blocking findings: 2'), true);
});

test('B4: every Terra spelling is refused by the guard and the memory refresher', () => {
  assert.equal(exportedAssertNotTerra, assertNotTerra);
  assert.equal(exportedIsBannedModel, isBannedModel);

  const variants = ['gpt-6-1-terra', 'gpt-6.1_terra', 'gpt-6.1 terra', 'openai/terra'];
  const textCtx = { experimental: { generate: { text: async () => '' } } };
  for (const variant of variants) {
    assert.equal(isBannedModel(variant), true, variant);
    assert.equal(isBannedModel({ providerID: 'openrouter', id: variant }), true, variant);
    assert.throws(() => assertNotTerra(variant), /Refusing banned GPT-6\.1 Terra model/);
    assert.throws(
      () => createReactiveGuard({ config: { decisionModel: `openrouter/${variant}` }, env: {} }),
      /Refusing banned GPT-6\.1 Terra model/,
    );
    assert.throws(
      () => createMemoryRefresher({ config: { model: `openrouter/${variant}` }, env: {} }),
      /Refusing banned GPT-6\.1 Terra model/,
    );
    assert.throws(
      () => makePluginTextLlm(textCtx, `openrouter/${variant}`, 100),
      /Refusing banned GPT-6\.1 Terra model/,
    );
  }
  assert.equal(isBannedModel('openai/gpt-6-luna'), false);
});

test('B5: banned config models never crash plugin setup; audit + permission guard stay operational', async (t) => {
  resetSharedBusForTests();
  const root = makeTempDir(t);
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'package.json'), '{}');
  const auditDir = path.join(root, 'audit');
  const blackboardDir = path.join(root, 'bb');
  useEnv(t, {
    OPENCODE_WORKFLOW_DECISION_MODEL: 'openai/gpt-6.1-terra',
    [AUDIT_DIR_ENV]: auditDir,
    [BLACKBOARD_DIR_ENV]: blackboardDir,
  });

  const mock = createMockContext({
    directory: project,
    options: {
      memoryRefresh: { config: { model: 'openai/gpt-6.1-terra' } },
    },
  });
  const cleanup = await auditPlugin.setup(mock.ctx);
  t.after(() => cleanup());

  await mock.call('permission.evaluate', {
    sessionID: 'ses_b5',
    action: 'bash',
    resources: ['rm -rf /'],
    effect: 'allow',
  });

  const entries = readAllJsonl(auditDir);
  assert.ok(entries.some((entry) => entry.event === 'plugin.error' && entry.where === 'guard.init'));
  assert.ok(entries.some((entry) => entry.event === 'plugin.error' && entry.where === 'memoryRefresh.init'));
  const permission = entries.filter((entry) => entry.event === 'permission.evaluate');
  assert.equal(permission.length, 1, 'Wave 1 permission guard must still evaluate');
  assert.equal(permission[0].guardOverridden, true);

  await mock.call('session.prompt', { sessionID: 'ses_b5', prompt: { text: 'go' } });
  for (let i = 0; i < 3; i += 1) {
    await mock.call('tool.execute.after', {
      id: `b5_${i}`,
      tool: 'shell',
      sessionID: 'ses_b5',
      agent: 'build',
      status: 'error',
      input: { command: 'npm test' },
      error: 'same failure',
    });
  }
  assert.equal(
    readAllJsonl(auditDir).filter((entry) => entry.event === 'guard.action').length,
    0,
    'fallback guard is disabled and must not judge',
  );
});

test('memory refresh: symlinked chat dirs and the live OpenCode config dir are ineligible; failures cool down', async (t) => {
  const root = makeTempDir(t);
  const chatDir = path.join(root, 'openchamber', '.config', 'openchamber', 'chats', 'chat-1');
  fs.mkdirSync(chatDir, { recursive: true });
  fs.writeFileSync(path.join(chatDir, 'package.json'), '{}');
  const linkPath = path.join(root, 'chat-link');
  fs.symlinkSync(chatDir, linkPath);

  assert.equal(isEligibleMemoryWorkspace(chatDir), false);
  assert.equal(isEligibleMemoryWorkspace(linkPath), false, 'symlink to an ephemeral chat dir must be rejected');
  assert.equal(isEligibleMemoryWorkspace(path.join(os.homedir(), '.config', 'opencode')), false);
  assert.equal(isEligibleMemoryWorkspace('/root/.config/opencode'), false);

  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'package.json'), '{}');
  let now = 5_000_000;
  let attempts = 0;
  const refresher = createMemoryRefresher({
    llm: async () => {
      attempts += 1;
      throw new Error('model down');
    },
    clock: () => now,
    dbPath: false,
  });

  const first = await refresher.maybeRefreshOnIdle({
    sessionID: 'ses_fail',
    isChild: false,
    directory: project,
    toolCalls: 5,
    fileMutations: 0,
    ctx: {},
  });
  assert.equal(first.reason, 'error');
  assert.equal(attempts, 1);

  now += refresher.config.cooldownMs - 1;
  const second = await refresher.maybeRefreshOnIdle({
    sessionID: 'ses_fail',
    isChild: false,
    directory: project,
    toolCalls: 5,
    fileMutations: 0,
    ctx: {},
  });
  assert.equal(second.reason, 'cooldown');
  assert.equal(attempts, 1, 'a failed refresh must not retry inside the cooldown');
});

test('B6: shellQuotePosix neutralizes shell metacharacters with zero expansion', (t) => {
  const dir = makeTempDir(t);
  const evil = path.join(dir, "x$(id)y`id`$HOME'quote.txt");
  const expected = path.resolve(evil);

  assert.equal(shellQuotePosix('plain'), "'plain'");
  assert.equal(shellQuotePosix("a'b"), "'a'\\''b'");

  const spec = buildWeeklyRsiAutomationSpec({ repoRoot: REPO_ROOT, outPath: evil });
  assert.ok(spec.action.command.includes(`--out ${shellQuotePosix(expected)}`));
  assert.ok(
    spec.action.command.includes(`node ${shellQuotePosix(path.join(REPO_ROOT, 'src', 'rsi-prune.mjs'))}`),
  );

  const echoed = spawnSync('sh', ['-c', `printf '%s\\n' ${shellQuotePosix(expected)}`], {
    encoding: 'utf8',
    cwd: dir,
  });
  assert.equal(echoed.status, 0);
  assert.equal(echoed.stdout.replace(/\n$/, ''), expected, 'metacharacters must not expand');

  for (const bad of ['', 'a\nb', 'a\rb', 'a\tb', 'a\0b', 'a\x7fb']) {
    assert.throws(() => shellQuotePosix(bad), /control|non-empty/i, JSON.stringify(bad));
  }
  assert.throws(() => shellQuotePosix(42), /non-empty string/i);
  assert.throws(() => shellQuotePosix(null), /non-empty string/i);
});

test('B6: protected report paths and control characters are rejected when the spec is built', (t) => {
  const dir = makeTempDir(t);
  for (const outPath of [
    '/root/.pi/x.txt',
    '/root/pi-projects/pi-workflow-tools/x.txt',
    path.join(REPO_ROOT, 'config', 'x.txt'),
  ]) {
    assert.throws(
      () => buildWeeklyRsiAutomationSpec({ repoRoot: REPO_ROOT, outPath }),
      /protected path/,
      outPath,
    );
  }

  assert.throws(
    () => buildWeeklyRsiAutomationSpec({ repoRoot: REPO_ROOT, outPath: path.join(dir, 'bad\nname.txt') }),
    /control characters/i,
  );

  const safe = buildWeeklyRsiAutomationSpec({ repoRoot: REPO_ROOT, outPath: path.join(dir, 'rsi.txt') });
  assert.match(safe.action.command, /^node '/);
});

test('bus: one shared subscriber delivers each unique eventID once, routed by session directory', async (t) => {
  resetSharedBusForTests();
  const root = makeTempDir(t);
  const auditDir = path.join(root, 'audit');
  const projectA = path.join(root, 'project-a');
  const projectB = path.join(root, 'project-b');
  fs.mkdirSync(projectA);
  fs.mkdirSync(projectB);
  useEnv(t, { [AUDIT_DIR_ENV]: auditDir, [BLACKBOARD_DIR_ENV]: path.join(root, 'bb') });

  const queueA = makePushEventDomain();
  const queueB = makePushEventDomain();
  const mockA = createMockContext({ directory: projectA });
  const mockB = createMockContext({ directory: projectB });
  mockA.ctx.event = queueA.domain;
  mockB.ctx.event = queueB.domain;
  const cleanupA = await auditPlugin.setup(mockA.ctx);
  const cleanupB = await auditPlugin.setup(mockB.ctx);
  t.after(async () => {
    queueA.close();
    queueB.close();
    await cleanupA();
    await cleanupB();
  });

  const event = {
    id: 'evt-route-1',
    type: 'session.usage.updated',
    location: { directory: projectB },
    data: { sessionID: 'ses_route_b', cost: 15, tokens: { input: 1000 } },
  };
  queueA.push(event);
  assert.equal(
    await waitFor(() => readAllJsonl(auditDir).some((entry) => entry.event === 'guard.action')),
    true,
    'the routed guard action must be recorded',
  );

  let entries = readAllJsonl(auditDir);
  assert.equal(entries.filter((entry) => entry.event === 'session.usage.updated').length, 1);
  const actions = entries.filter((entry) => entry.event === 'guard.action');
  assert.equal(actions.length, 1, 'guard must see the event exactly once');
  assert.equal(actions[0].sessionID, 'ses_route_b');
  assert.equal(actions[0].action, 'hard_stop');
  assert.equal(actions[0].tripwire, 'hard_spend_fuse');

  queueA.push({ ...event });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  entries = readAllJsonl(auditDir);
  assert.equal(entries.filter((entry) => entry.event === 'session.usage.updated').length, 1);
  assert.equal(entries.filter((entry) => entry.event === 'guard.action').length, 1);
});

test('bus: a completed rotation propagates metadata to bus.getSessionMeta(newSessionID)', async (t) => {
  resetSharedBusForTests();
  const root = makeTempDir(t);
  const auditDir = path.join(root, 'audit');
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  useEnv(t, { [AUDIT_DIR_ENV]: auditDir, [BLACKBOARD_DIR_ENV]: path.join(root, 'bb') });

  const queue = makePushEventDomain();
  const mock = createMockContext({
    directory: project,
    options: {
      guard: {
        config: { judgeCooldownMs: 0 },
        judge: async () => ({ action: 'rotate_session', rationale: 'bloat' }),
      },
    },
    session: {
      async create() {
        return { id: 'ses_rotated_new' };
      },
      async prompt() {},
      async interrupt() {},
      async synthetic() {},
    },
  });
  mock.ctx.event = queue.domain;
  const cleanup = await auditPlugin.setup(mock.ctx);
  t.after(async () => {
    queue.close();
    await cleanup();
  });

  queue.push({
    id: 'usage-1',
    type: 'session.usage.updated',
    location: { directory: project },
    data: { sessionID: 'ses_pre', cost: 0, tokens: { input: 50_000 } },
  });
  assert.equal(
    await waitFor(() => readAllJsonl(auditDir).some((entry) => entry.event === 'session.usage.updated')),
    true,
  );

  queue.push({
    id: 'usage-2',
    type: 'session.usage.updated',
    location: { directory: project },
    data: { sessionID: 'ses_pre', cost: 0, tokens: { input: 190_000 } },
  });
  assert.equal(
    await waitFor(() =>
      readAllJsonl(auditDir).some((entry) => entry.event === 'guard.action' && entry.action === 'rotate_session'),
    ),
    true,
  );

  const meta = getSharedBus(auditDir).getSessionMeta('ses_rotated_new');
  assert.ok(meta, 'rotated session metadata must be registered in the shared bus');
  assert.equal(meta.rootSessionID, 'ses_pre');
  assert.equal(meta.directory, path.resolve(project));
  assert.equal(meta.agent, 'build');
});

test('shared-bus: getSharedSlot never collides with Object prototype keys', (t) => {
  const dir = makeTempDir(t);
  const bus = getSharedBus(path.join(dir, 'audit'));

  assert.equal(bus.getSharedSlot('toString', () => 'slot-toString'), 'slot-toString');
  assert.equal(bus.getSharedSlot('constructor', () => 'slot-constructor'), 'slot-constructor');
  assert.equal(bus.getSharedSlot('__proto__', () => 'slot-proto'), 'slot-proto');
  assert.equal(
    bus.getSharedSlot('toString', () => {
      throw new Error('factory must not run twice');
    }),
    'slot-toString',
  );
  assert.equal(
    bus.getSharedSlot('constructor', () => {
      throw new Error('factory must not run twice');
    }),
    'slot-constructor',
  );
});
