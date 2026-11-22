# Vision — opencode-workflow

**Status:** accepted (Waves 1, 2A, 2B, 2C, 3A, 4A, 4B, 6A, 6B and 7B security/correctness hardening
complete; live activation performed 2026-11-22 and re-synced 2026-11-22 09:59 UTC so Waves 4A/4B/6A/6B
are all live — the installed `opencode.jsonc` is byte-identical to `config/opencode.jsonc`.
`npm test` is 101/101 PASS and `npm run verify -- --schema --live` PASSes (exit 0) after Wave 7B fixed
`validateResolvedConfig()` to accept OpenCode 2.3.2's real `debug config` array-of-documents output.
Paid-turn and interactive-MCP verification remain open — see Open items.)
**Owner:** user (sole decision authority)
**Authoritative source:** this file. Sub-plans, handoffs and summaries must not restate or narrow it.

## Destination

Final goal: production-ready OpenCode v2 workflow repository (`/root/pi-projects/opencode-workflow`) and live activation on this machine alongside untouched Pi.

A single lean ruleset plus a routed multi-vendor agent roster drives OpenCode v2 (2.3.2) on this
machine: Gemini 4 Neon as primary driver, cheap DeepSeek for bounded work, independent
cross-vendor reviewers and fact-checkers, two escalation tiers, an audit plugin that records what
actually happened, and a thin outer-loop supervisor that judges *semantic* progress instead of
counting turns. Pi (the existing agent harness, its config, and `pi-search`) stays installed,
untouched and fully usable.

## Requirements

| ID | Requirement |
| --- | --- |
| **OCW-01** | Lean global `AGENTS.md` under 2,800 characters: grounded claims with explicit references, mandatory cross-vendor fact-check, two-line intent/check progress updates, primary-agent auto-routing rules. No frontend/CSS or other domain bloat. |
| **OCW-02** | `config/opencode.jsonc` valid against the exact OpenCode v2.3.2 schema (`https://opencode.ai/config.json`), verified with `opencode debug config` and `opencode debug agents` under an isolated `XDG_CONFIG_HOME`. Includes compaction, tool-output and media limits, and a history-calibrated permission ruleset (silent everyday read/test/build/inspect, `ask` on destructive and remote mutations, and on `.env`/`.env.*` across read, edit, write, patch and shell/bash command globs; `*.env.example` auto-allowed afterwards **only** for the file-path tools `read`/`edit`/`write`/`patch`, because their resource is a single path, while `shell`/`bash` command strings that mention `.env*` fail closed to `ask` — a trailing `*.env.example` allow on a command surface would let `cat .env # .env.example` or `cat .env; cat .env.example` bypass the `.env` ask). |
| **OCW-03** | Verified model lineup pinned by catalog-resolvable IDs: Gemini 4 Neon (`#high`) primary, DeepSeek V4.1 Flash 1017 worker, Claude Sonnet 5.5 reviewer/fact-checker, Claude Opus 5.5 and Claude Fable 5.2 escalation tiers, GPT-6.2 Sol as the non-Anthropic reviewer. The System-1 supervisor (OCW-07) is approved to use `openai/gpt-6-luna` or `deepseek/deepseek-v4.1-flash-1017`, with `deepseek/deepseek-v4.1-flash-1017` as the default. GPT-6.1 Terra is banned everywhere. |
| **OCW-04** | Agent roster wired in config: `build` and `plan` primaries, `worker`, `reviewer`, `fact-checker`, `escalate-opus`, `escalate-fable`, `alt-reviewer` subagents, each with bounded `steps` and permissions that deny writes where the role is read-only. |
| **OCW-05** | `pi_search` MCP server registered (local, `codemode: true`) so research, scraping and fact-checking use the existing verified search engine rather than a weaker built-in. |
| **OCW-06** | Audit plugin (Wave 2B) in `plugins/audit-logger`: records tool calls, permission decisions, agent routing and session lifecycle to a durable local log, redacts secrets before any truncation, fails closed when the audit directory/file cannot be verified as 0700/0600 or is a symlink/non-regular file, and never blocks the agent loop on logging failure. |
| **OCW-07** | Outer-loop System-1 Supervisor (Wave 2C): thin `@opencode/client` loop that drives sessions, detects *semantic* progress versus spin, escalates or stops with a reason, keeps `MEMORY.md` bounded (≤ 2,500 characters per project), and enforces a weekly multi-project RSI pruning guard (arXiv:2611.03219). No dumb hard turn/token cutoffs. |
| **OCW-08** | Live activation on this machine: `npm run sync` installs the repo's config into `~/.config/opencode/`, the audit plugin loads at startup with zero warnings, permissions behave as designed, and a documented rollback restores the previous config. Pi's own config (`/root/.pi`, `/root/pi-projects/pi-workflow-tools`) is not modified. |
| **OCW-09** | Repository hygiene: Git repository with intentional commits, README and CHANGELOG kept current, automated tests (`npm test`) and `npm run verify` schema/permission checks, no secrets in the tree, and no paid LLM calls in any test. |

### Requirement evidence (2026-11-22, zero paid LLM calls)

- **OCW-01** — `config/AGENTS.md` is 2,261 characters; `npm run verify` enforces the 2,800 target /
  3,000 hard ceiling on every run.
- **OCW-02** — `npm run verify -- --schema` PASS (JSONC, Terra ban, permissions, agents, AGENTS.md,
  binary checks, live schema) for both the repository copy and the live install
  (`--live`). `opencode --standalone debug config` resolves three config documents against the live
  `~/.config/opencode/opencode.jsonc` with `model` = `openrouter/google/gemini-4-neon` + variant `high`.
- **OCW-03 / OCW-04** — `opencode --standalone debug agents` lists the 8 configured agents
  (`build`, `plan`, `worker`, `reviewer`, `fact-checker`, `escalate-opus`, `escalate-fable`,
  `alt-reviewer`) plus 5 built-ins, each with its pinned model; GPT-6.1 Terra appears nowhere
  (Terra scan in `npm run verify` and `npm run prune`). Since Wave 6B the verifier enforces an
  explicit `APPROVED_MODELS` catalog for the eight roster agents, every other configured agent and
  the top-level `model`, so an id that merely *looks* like `provider/model`
  (`not-a-catalog/model`) is rejected, not just the Terra string.
- **OCW-05** — Partially verified: OpenCode logs `message="mcp connected" server=pi_search tools=4`
  on every location-materializing run, and the normalized config keeps `mcp.servers.pi_search` with
  `codemode: true`. **Unverified:** an interactive MCP tool invocation inside a real session, and
  `opencode --standalone mcp list` still prints `No MCP servers configured` (2.3.2 display gap).
- **OCW-06** — `plugins/audit-logger` loads with zero errors in the live install and writes real
  `plugin.loaded` JSONL with `loggingEnabled: true` (see CHANGELOG Wave 3A). Real
  tool/permission/shell record shapes are proven by the end-to-end mocked-hooks integration test.
- **OCW-07** — Supervisor, `MEMORY.md` ceiling, and the RSI multi-project guard are implemented and
  covered by the offline suite (101/101 tests pass in the current tree); they have not yet driven a
  live paid session. The runtime default is aligned with OCW-03
  (`DEFAULT_SUPERVISOR_MODEL = "deepseek/deepseek-v4.1-flash-1017"`), with GPT-6 Luna available via
  `--model`. Spend fuses validate their *derived* defaults too (Wave 6B), and per-proposal RSI
  evidence requires an attributed session on the same record, so a session-less record cannot
  fabricate cross-project support.
- **OCW-08** — Live activation performed: `npm run sync` installed the config, rotated the exposed
  `service.json`, retired v1 files into `~/.config/opencode/v1-disabled/`, and `/root/.pi` was verified
  byte-identical (407-file manifest) before and after. Rollback: restore
  `/root/.opencode-v1-backup-20261122/config` (and optionally `.../bin/opencode`) as documented in
  `README.md`.
- **OCW-09** — `npm test` 60/60 PASS (Wave 3A), 87/87 PASS after Wave 4A, 98/98 PASS after Wave 6B,
  and **101/101 PASS** after Wave 7B (26 audit-logger + 75 workflow-automation); README/CHANGELOG kept
  current; no secrets in the tree; no paid LLM call in any test or verification step. **Met for the
  verifier:** `npm run verify` (isolated binary run), `npm run verify -- --schema --skip-binary` and
  `npm run verify -- --schema --live` against the real `~/.config/opencode/` all end **Verify PASS,
  exit 0** (the live run reports 14 PASS lines, 0 FAIL and one known 2.3.2 `mcp list` display WARN).

### Wave 6B hardening evidence (2026-11-22, zero paid LLM calls)

- **OCW-07 fuse integrity** — `strictPositiveNumber()` validates the *fallback* too, so
  `maxUsdPerSession * 2 → Infinity` refuses to start (`InvalidSupervisorOptionError`) instead of
  silently disabling the cumulative fuse. Regression test: "an overflowing derived cumulative fuse is
  rejected instead of becoming Infinity".
- **OCW-07 attribution integrity** — `pathMatchesWorkspace()` fails closed on an absolute/relative
  mismatch (a bare `shared` label never matches `/work/alice/shared`), and `recordEvidence()` counts
  a project only when the same record carries an attributed session. Regression tests: "a bare
  relative workspace label never matches an absolute workspace" and "a session-less record cannot
  supply the second project that unlocks the per-proposal guard".
- **OCW-07/OCW-09 path safety** — `realpathDeep()` resolves dangling symlinks segment by segment
  (≤ 40 hops) in both `src/rsi-prune.mjs` and `scripts/sync-global.mjs`, the RSI report is opened
  `O_NOFOLLOW`, and `sync-global`'s atomic temp write uses a random name opened
  `O_CREAT|O_EXCL|O_NOFOLLOW` with `lstat`-checked destinations. Regression tests: "--out refuses a
  dangling symlink that points into a protected tree", "a planted predictable temp symlink is never
  opened or written through", "refuses a dangling symlink into /root/.pi".
- **OCW-02/OCW-03/OCW-06 verifier invariants** — the verifier enforces the approved model catalog,
  resolves `cat .env # .env.example` / `cat .env; cat .env.example` to ask/deny on `shell` and
  `bash`, and accepts audit evidence only from a `plugin: "opencode-workflow-audit"` record with
  `loggingEnabled: true`. Regression tests: "rejects a model id that is outside the approved OCW-03
  catalog", "rejects a *.env.example shell/bash bypass…", "audit evidence requires a plugin.loaded
  record and rejects a disabled logger", "binary runs never accept historical plugin.loaded evidence".
- **Full suite** — `npm test` **98/98 PASS** (26 audit-logger + 72 workflow-automation).
- **Live re-sync** — `npm run sync` installed the hardened config (previous copy at
  `opencode.jsonc.bak-2026-11-22T09-59-40-970Z`); `~/.config/opencode/opencode.jsonc` sha256
  `23fd8a42…` equals `config/opencode.jsonc`, and `AGENTS.md` was already identical.
- **Verifier defect found here, fixed in Wave 7B** — `npm run verify -- --schema --live` ended
  `FAIL debug config did not resolve to a JSON object`: `validateResolvedConfig()` assumed a single
  config object, while `opencode --standalone debug config` prints an array of three documents with
  the config under `info` and `model` normalized to `{providerID, model, variant}`. Every other live
  check passed and the binary exited 0, so the config was never at fault.

### Wave 7B evidence (2026-11-22, zero paid LLM calls)

- **OCW-09 resolved-config gate** — `validateResolvedConfig()` unwraps 2.3.2's array of
  `{type,path,info}` entries (merging `info` from `type:"document"` entries in output order; the
  `directory` entries carry an empty `info`) and accepts `model` as either a string id or the
  normalized `{providerID, model, variant}` object, normalizing both to one `provider/model#variant`
  id that is still held to the OCW-03 catalog. `{}`, `[]`, a directory-only list, `null`, a missing
  model, a non-local/`codemode: false` `pi_search`, a missing `audit-logger` plugin and an unapproved
  normalized model object all remain hard failures. Regression tests (72 → 75 workflow-automation):
  "resolved debug config accepts the real 2.3.2 array-of-documents shape", "resolved debug config
  rejects document-less and unapproved resolved shapes", and "binary runs accept the real 2.3.2
  array-shaped debug config end to end".
- **OCW-09 verification, end-to-end** — `npm test` **101/101 PASS** (26 audit-logger + 75
  workflow-automation, 0 fail, 0 skip); `npm run verify` (isolated) **Verify PASS, exit 0**; `npm run
  verify -- --schema --skip-binary` **Verify PASS, exit 0**; `npm run verify -- --schema --live`
  against the real `~/.config/opencode/` **Verify PASS, exit 0** with 14 PASS lines, 0 FAIL and one
  WARN (`mcp list did not show pi_search`, the known 2.3.2 display gap).

### Wave 4A hardening evidence (2026-11-22, zero paid LLM calls)

- **OCW-02 `.env` bypass closed** — `npm run verify -- --schema` PASS: baseline allow first, then
  `ask` for `.env`/`.env.*` on read/edit/write/patch plus `bash`/`shell` command globs
  (`*.env*`, `* .env*`, `*/*.env*`, `*.env *`, `*.env`), and `*.env.example` allowed afterwards on
  all six surfaces. Live schema check against `https://opencode.ai/config.json` passes.
- **OCW-06 redaction regressions** — `node --test test/audit-logger.test.mjs` 26/26 PASS, including
  `PASSWORD=hunter2`, `TOKEN=secretvalue`, `API_KEY=secretvalue`, `OPENAI_KEY=supersecretvalue`,
  textual `{"apiKey":"supersecretvalue"}`, a 4,000-char truncated PEM block with zero
  `SECRETKEYMATERIAL` leakage, `Error.name = 'sk-...'`, and revoked Proxy objects.
- **OCW-06 writer/lifecycle regressions** — symlinked and non-regular daily files are refused with
  the symlink target untouched, a file whose 0600 mode cannot be verified disables writing, and a
  hanging `dispose()` is bounded at 1,500 ms.
- **Full suite** — `npm test` 87/87 PASS in the current tree (26 audit-logger tests plus the other
  suites, which also carry later-wave additions).

## Non-goals

- Replacing, wrapping, or re-implementing `pi-search`. It stays a Rust binary consumed over MCP.
- Any use of **GPT-6.1 Terra** — in any agent, at any tier, for any reason.
- Dumb hard cutoffs: fixed turn counts, token ceilings, or wall-clock timers as the primary stop
  condition for the supervisor loop.
- Global frontend/CSS/UI rules in `AGENTS.md`; those stay in the repositories that own them.
- Modifying, migrating, or "cleaning up" the Pi installation or `pi-workflow-tools`.
- Publishing packages, pushing to remotes, or deploying anything without explicit user approval.

## Production definition of done

1. OCW-01..OCW-09 each have executable evidence: test output, `opencode debug` output, plugin
   log sample, supervisor run log, or a manual check recorded in the CHANGELOG.
2. `npm test` and `npm run verify` pass from a clean clone with no network access to paid
   providers; config validation runs against a real OpenCode binary.
3. Live activation performed with the user present; Pi still starts and behaves as before; a
   documented one-command rollback has been exercised.
4. Every factual claim in the docs carries a reference or is marked unverified.
5. Remaining gaps are listed explicitly rather than smoothed over.

## Open items

- **Verified done:** Waves 2B (audit plugin, `npm run sync`, `npm run verify`), 2C (supervisor,
  `MEMORY.md` ceiling, RSI guard), and 3A (scripts, JSONL schema integration, live activation,
  README/CHANGELOG updates). Evidence is in `CHANGELOG.md` under "Verified during Wave 3A".
- **Unverified — live paid OpenRouter turn:** an interactive `opencode` prompt or a
  `npm run supervise` run has not been executed, so model routing, agent hand-off and cost
  accounting are verified only at config/catalog level. Needs explicit approval because it spends
  money.
- **Unverified — interactive MCP tool invocation:** `pi_search` connects with 4 tools, but no
  session has called an MCP tool yet. `opencode mcp list` also still reports no servers (2.3.2
  display gap) and must not be treated as proof either way.
- **Live telemetry is still thin:** the live audit log currently holds only `plugin.loaded` /
  `plugin.stopped` records from zero-cost `debug` runs; the analyzer's real-shape handling is proven
  by the mocked end-to-end test rather than by a long live coding session.
- **Rollback rehearsal:** the documented one-command rollback from
  `/root/.opencode-v1-backup-20261122/` has **not been executed** on this machine (it would swap the
  live config back and forth and needs an approved maintenance window). Its readiness was verified
  non-destructively instead: every retired file is sha256-identical to the snapshot copy and the
  backed-up v1 binary runs and reports `1.18.32`. Production definition of done item 3 ("rollback
  exercised") therefore remains open.
- **Resolved-config shape mismatch — CLOSED in Wave 7B.** Wave 6B's `validateResolvedConfig()`
  expected one config object with a string `model`, while the real 2.3.2 output is an array
  (`{type:"document",path,info:{…}}` + two `{type:"directory"}` entries) whose `model` is
  `{providerID,model,variant}`. Wave 7B unwraps the array and normalizes the model object, so
  `npm run verify` now passes in all three modes (binary, `--skip-binary`, `--live`) instead of having
  no passing binary/live mode.
- **Live re-sync is current — Waves 4A/4B/6A/6B are all live.** `~/.config/opencode/` was re-synced on
  2026-11-22 (09:17 and again 09:59 UTC); `opencode.jsonc` is byte-identical to `config/opencode.jsonc`
  (sha256 `23fd8a42…`), so the strengthened `.env` ask rules, the Wave 6A removal of the `shell`/`bash`
  `*.env.example` allow, and the hardened scripts are installed. Previous copies:
  `opencode.jsonc.bak-2026-11-22T09-47-04-566Z` (Wave 4A/4B) and
  `opencode.jsonc.bak-2026-11-22T09-59-40-970Z` (current rollback point).
- **Hygiene:** `~/.config/opencode/node_modules` still contains the v1 `@opencode-ai/plugin@1.18.14`
  tree (inert for v2, not managed by `npm run sync`).
- Benchmark percentages quoted from the Wave 1 audit remain reported, not re-verified (see
  `Decisions.md`).
