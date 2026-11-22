# Decisions

Decisions are recorded with their rationale, the evidence that settled them, and what remains
unverified. Dates are 2026-11-22 unless noted.

## D1 — Language: TypeScript on Node.js ESM (Rust stays where it already is)

**Decision.** This repository is TypeScript/Node.js ESM. `pi-search` stays Rust and is consumed
over MCP; no Rust crate is re-implemented here.

**Rationale (global Rust-first policy, explicit exception).** The global policy allows another
language when the task has a significant task-specific runtime/ecosystem advantage. Here the
contract is external: OpenCode v2.3.2 ships its extension surface as npm packages —
`@opencode/plugin@2.3.2` and `@opencode/client@2.3.2` — whose entry points are
`./dist/promise/index.{d.ts,js}` ESM modules typed against `effect@4` and loaded by the OpenCode
host at runtime. A plugin cannot be written in Rust: the host imports a JavaScript module, resolves
`@opencode/plugin` and `effect` to its own instances, and expects `Plugin.define({ id, setup })`
(see `node_modules/@opencode/plugin/dist/promise/plugin.d.ts`). The client likewise is a generated
TypeScript HTTP SDK (`OpenCode.make({ baseUrl, headers })`). Writing a Rust bridge would add a
subprocess, an IPC protocol, and a second failure domain for zero capability.

**Evidence.** Installed tree at `node_modules/@opencode/{plugin,client,schema,protocol,ai,util}`
version `2.3.2`; `npm ls` clean; both package manifests declare `"type": "module"` and
`exports[".` → `./dist/promise/index.js`.

**Rejected alternative.** "Rust core with a thin TS plugin shell": the audit plugin's only work is
subscribing to host hooks and appending to a log — the Rust core would be an empty RPC hop.

**Gap / watch item.** If the supervisor (Wave 2C) grows CPU-bound analysis (e.g. semantic diff
scoring over large transcript corpora), that specific component may justify a Rust crate behind a
CLI boundary. Not decided, not scheduled.

## D2 — Model lineup

**Decision.**

| Role | Model ID (OpenCode v2) | Why |
| --- | --- | --- |
| Primary driver (`build`, `plan`) | `openrouter/google/gemini-4-neon#high` | **Reported** strongest available general driver at acceptable cost (Wave 1 review of Artificial Analysis / OpenRouter, 2026-11-22; not re-benchmarked here). Context 1,048,576 and the `#high` reasoning variant were **observed** in the local OpenCode catalog on 2026-11-22. |
| Routine worker (`worker`) | `openrouter/deepseek/deepseek-v4.1-flash-1017` | Cheap, fast open-weights model for fully specified edits/tests (cost from local catalog, see below; not a benchmark re-run). |
| Reviewer / fact-checker | `openrouter/anthropic/claude-sonnet-5.5` | Strong at careful cross-checking; independent vendor from the primary driver (role choice, not a measured ranking). |
| Mid escalation (`escalate-opus`) | `openrouter/anthropic/claude-opus-5.5` | Better at stuck debugging and high-blast-radius changes (reported tier positioning; not measured here). |
| Top escalation (`escalate-fable`) | `openrouter/anthropic/claude-fable-5.2` | **Reported** highest-ceiling, expensive, rarely-used fallback (OpenRouter model page, 2026-11-22); not benchmarked in this repo. |
| Non-Anthropic reviewer (`alt-reviewer`) | `openrouter/openai/gpt-6.2-sol` | Cross-vendor check whenever Anthropic wrote the code (role requirement, not a ranking claim). |
| System-1 supervisor (`OCW-07`, default) | `openrouter/deepseek/deepseek-v4.1-flash-1017` | Approved default: cheap enough to judge every milestone. `openrouter/openai/gpt-6-luna` is the approved alternative. |
| Optional cheap reviewer (documented, not wired) | `openrouter/moonshotai/kimi-k3.1-pro` | Open-weights reviewer at medium effort if cost pressure appears (catalog price observed 2026-11-22). |

**Banned.** `openrouter/openai/gpt-6.1-terra*` — user directive, no exceptions. Note the catalog
does contain `openai/gpt-6.1-terra-pro`; it must never appear in this config or in any agent
recommendation.

**Verified in this session (primary, zero-cost, reproducible).** Model metadata read from the live
catalog through the OpenCode v2 API (`client.model.list({ types: ["chat"] })`) against
`opencode serve`:

| Model | Context | Output | $/Mtok in → out | Variants |
| --- | --- | --- | --- | --- |
| google/gemini-4-neon | 1,048,576 | 943,718 | 3 → 15 (cache read 0.15, write 0.083) | low, medium, high, xhigh |
| deepseek/deepseek-v4.1-flash-1017 | 1,048,576 | 393,216 | 0.15 → 0.60 | none, low, high, max |
| anthropic/claude-sonnet-5.5 | 1,000,000 | 128,000 | 2 → 10 | low…max |
| anthropic/claude-opus-5.5 | 1,000,000 | 128,000 | 4 → 20 | low…max |
| anthropic/claude-fable-5.2 | 1,000,000 | 128,000 | 8 → 40 | low…max |
| openai/gpt-6.2-sol | 1,050,000 | 128,000 | 2 → 10 (4 → 15 past 272k) | low…max |
| moonshotai/kimi-k3.1-pro | 1,048,576 | 943,718 | 0.253 → 8.8 | none, low, high, max |

Reproduce: start `opencode serve --port <p>` with an isolated `XDG_CONFIG_HOME`, then call
`client.model.list`. The catalog comes from models.dev metadata bundled/served by OpenCode — no
inference request, no charge.

**Cost accounting vs billing.** The OpenCode model catalog drives OpenCode's **local** cost
accounting (the numbers the supervisor's `--max-usd` fuse and the audit analyzers see). It is not a
bill: the provider's own billing — OpenRouter for these IDs — is authoritative for what is actually
charged, and the two can diverge (markup, cache pricing, negotiated rates, catalog staleness). Wave 1
recorded DeepSeek V4.1 Flash 1017 at `$0.02/$1.00`; the local catalog on this machine reports
`$0.15/$0.60` input/output. The catalog value is recorded here because it is what the local accounting
uses; the Wave 1 figure remains **unverified / reported** until re-checked against the provider page.

**External sources cited by Wave 1 for the lineup (reachable, content not re-audited here).**
Each returned HTTP 200 at 2026-11-22:

- Artificial Analysis — https://artificialanalysis.ai/ (leaderboard/quality index cited for
  primary-driver ranking and speed claims)
- OpenRouter rankings — https://openrouter.ai/rankings
- Model pages — https://openrouter.ai/google/gemini-4-neon,
  https://openrouter.ai/deepseek/deepseek-v4.1-flash-1017,
  https://openrouter.ai/anthropic/claude-sonnet-5.5,
  https://openrouter.ai/openai/gpt-6.2-sol,
  https://openrouter.ai/moonshotai/kimi-k3.1-pro
- Google DeepMind model family pages — https://deepmind.google/models/ ,
  https://deepmind.google/models/gemini/
- arXiv:2611.03219 — https://arxiv.org/abs/2611.03219 (RSI pruning guard, used by D3)

**Honest status.** Benchmark percentages attributed to these sources (e.g. "61.4 AA", "63.9 %
T-Bench 4.1") come from the Wave 1 audit and the 89-session empirical telemetry corpus. This
session verified that the URLs resolve and that every model ID resolves in the local catalog; it did
**not** re-read the pages' numbers. Those percentages are therefore **reported, not re-verified**
here, and the Wave 3 activation pass must re-check them with `pi_search` and record the concrete
source snapshots. No paid inference was used to produce this document.

## D3 — Outer-loop architecture: OpenCode v2 + thin client supervisor

**Decision.** The outer loop is a thin `@opencode/client` "System-1 Supervisor" process that drives
OpenCode sessions, not a Pi layer that wraps OpenCode, and not a fork of OpenCode's own agent loop.

**Rationale.**
1. *One source of truth for execution.* OpenCode already owns sessions, tool execution, permission
   prompts, compaction and subagents. Wrapping it from outside duplicates session state and creates
   two competing compaction policies. The client API exposes exactly what a supervisor needs:
   `session.create/prompt/interrupt/wait`, `message.list`, `session.context`, plus an event stream
   (`session.execution.*`, `session.step.*`, `session.tool.*`, `session.idle`, `session.usage.updated`,
   `permission.asked`).
2. *Pi must stay untouched.* Pi (`/root/.pi`, `pi-workflow-tools`) remains usable and unmodified; the
   supervisor is a separate Node process talking HTTP to the OpenCode server, so Pi's extension
   surface and this workflow never share mutable state.
3. *Semantic progress, not turn counting.* A fixed turn/token cutoff either kills productive long
   runs or lets spinning runs burn budget. The supervisor judges each round on evidence: new tool
   results, files changed (`vcs.diff`, `session.diff`), tests moved from fail to pass, new
   information in the transcript. Repeated identical actions, unchanged diffs, and oscillating
   failures are treated as spin and trigger a strategy change or escalation with a stated reason.
4. *Bounded memory.* `MEMORY.md` per project is capped at 2,500 characters: enough for verified
   decisions and current state, small enough to always re-read without context inflation. Longer
   history belongs in the repo's own docs.
5. *RSI guard.* Per arXiv:2611.03219, self-improving loops can over-fit and prune away capabilities
   that later matter. The supervisor runs a weekly multi-project review that compares cross-project
   outcomes before any pruning of rules, prompts or routing policy is accepted — pruning is proposed,
   justified with evidence, and approved by the user, never applied silently.

**Rejected alternatives.**
- *Pi skill that spawns OpenCode per task*: one process per step, no shared session context, no
  event stream — cannot judge progress semantically.
- *Fork/patch OpenCode internals*: upgrade-hostile. v2.3.2 already exposes the needed hooks
  (`Plugin.define` with `tool.hook("execute.after")`, `permission.hook("evaluate")`,
  `event.subscribe`), so internals are not needed.
- *Pi-native wrapper implementing its own agent loop*: reimplements tool execution, permissions and
  compaction, and diverges from OpenCode's own semantics.

**Consequences / boundaries.** The supervisor is a System-1 driver: it decides *when* to nudge,
escalate, or stop, and *what evidence* justifies that. It does not re-implement OpenCode's agent
loop or tool layer.

**Status.** Wave 2B (audit plugin) and Wave 2C (supervisor, `MEMORY.md` ceiling, RSI pruning guard)
are implemented and covered by `test/*.test.mjs`; this section records the contract they satisfy. The
remaining gap is live exercise: no paid supervisor session has driven this loop yet (see
`Vision.md` Open items).

## D4 — Config shapes verified against OpenCode 2.3.2 (not assumed)

- `#high` variant syntax is accepted for both top-level `model` and `agents.<id>.model`; `debug
  config` normalizes `openrouter/google/gemini-4-neon#high` to
  `{ providerID: "openrouter", model: "google/gemini-4-neon", variant: "high" }`. The variant exists
  in the catalog with `reasoning.effort: "high"`.
- `mcp.servers.<name>` requires `type: "local"` and a `command` **array** (there is no `args` field
  in 2.3.2); `cwd`, `environment`, `codemode` are valid. The legacy `mcp.<name>` form decodes into
  the same `servers` shape.
- `plugins` takes a local **directory**; the host resolves `server`, then `index` inside it
  (`@opencode/plugin` `Host.resolve`). A plugin module default-exports `Plugin.define({ id, setup })`;
  verified by loading a stub plugin and observing `setup` receive `context.app = { name: "cli",
  version: "2.3.2" }`.
- Permission rules are an ordered array of `{ action, resource, effect }` where later rules win.
  Built-in agent defaults are emitted *before* config rules, so `.env` protection must be re-declared
  **after** the baseline `allow *` rule or it gets overridden — this ordering is applied in
  `config/opencode.jsonc` deliberately. Since Wave 4A the gate covers `read`, `edit`, `write`,
  `patch`, `bash` and `shell`: file actions match `*.env` / `*.env.*`, and shell actions match
  command-shaped globs (`*.env*`, `* .env*`, `*/*.env*`, `*.env *`, `*.env`). `*.env.example` is
  explicitly re-allowed after the asks on all six surfaces.
- The shell tool appears in the tool catalog as `shell`, while the legacy permission schema
  enumerates the action as `bash`. Because the effective action name could not be confirmed without
  a paid model turn, every high-risk pattern is declared for **both** `bash` and `shell`.
- Client auth: `OpenCode.make({ baseUrl, headers: { authorization: "Basic " + base64("opencode:" +
  password) } })`; the password is printed by `opencode serve` and stored in the service file.
- Config validation is lenient at runtime: an invalid `effect` value silently drops the whole
  `permissions` block (observed). Schema conformance is therefore checked separately in
  `npm run verify` against `https://opencode.ai/config.json`, not inferred from a clean run.

**Unresolved.** `client.mcp.list()` returned an empty list in isolated runs even though the config
decoded with `pi_search` present, and `tool.list()` showed no MCP tools at plugin setup time. MCP
materialization appears to be per-location and session-driven; this must be confirmed during Wave 3
live activation before OCW-05 is called done.

## D5 — Wave 4A security/correctness hardening (reviewer Part A)

**Decision.** Fix five blocking findings with fail-closed behaviour rather than best-effort logging,
and lock each one with a regression test.

1. **Config, not just policy prose.** `.env` protection applies to `read`/`edit`/`write`/`patch` and
to `bash`/`shell` command globs, and `*.env.example` is re-allowed last. A read-only rule let write
and shell paths bypass the documented intent (OCW-02).
2. **Redact before truncating.** The 4,000-character cap used to run first, so a PEM body or token
straddling the boundary survived as a prefix. Redaction now runs over the whole string, followed by
a fail-closed rule for an unclosed `-----BEGIN … PRIVATE KEY-----` block (the entire tail is key
material) and only then the length cap.
3. **Structural redaction is not enough for text.** Bare `KEY=VALUE` and quoted JSON `"key":"value"`
pairs are matched generically and filtered through `isSensitiveKey()`, so provider-specific names
such as `OPENAI_KEY` are covered without a per-provider allowlist. `Error.name` gets the same
redaction and cap as `Error.message`.
4. **Hostile objects cannot escape `redact()`.** Revoked Proxy objects throw from `instanceof`,
`Array.isArray` and property reads; every reflective operation is individually guarded and the walk
degrades to `[Unreadable]`.
5. **Audit writer fails closed.** 0700/0600 are verified after `chmod`/`fchmod`; if verification
fails the writer disables itself instead of appending to a world-readable file. The daily file is
opened with `O_NOFOLLOW` (plus `O_NONBLOCK` so a FIFO cannot block) and checked with `fstat` for a
regular file before `fchmodSync`, refusing symlinks and FIFOs. `dispose()` during teardown is bounded
at 1,500 ms so a hung host hook cannot hang cleanup.

**Verified.** `node --test test/audit-logger.test.mjs` 26/26 PASS and `npm test` 87/87 PASS in the
current tree on 2026-11-22 with zero paid LLM calls; `npm run verify -- --schema` PASS including
the live `https://opencode.ai/config.json` check.

**Tradeoff.** Redacting before truncation means regex passes see long strings (a large file read or
base64 body); the patterns are linear and the node/length budgets still bound the result, but the
first pass is no longer capped at 4,000 characters. Fail-closed mode verification can disable audit
logging on an exotic filesystem where `chmod` is meaningless (e.g. some network/FUSE mounts); the
plugin still loads and records the disabled reason in `plugin.loaded`.
