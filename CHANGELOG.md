# Changelog

All notable changes to this repository. Format loosely follows Keep a Changelog; this project has
not been published, so sections use plan waves instead of release numbers.

## [Unreleased]

### Fixed — Wave E: the last two scorer regex defects from the independent Reviewer sign-off

Two three-line regex defects in `bench/shootout/scorers.mjs`, each with a regression test. No config,
no harness behaviour and no artifact changed; zero paid LLM calls.

- **`splitFindingBlocks()` now splits contiguous list/numbered finding lines**
  (`^\s*(?:\d+[.)]|[-*])\s+`) into separate finding blocks while the active markdown heading stays the
  `section` context. Previously `1. src/routes.mjs reviewed` and `2. src/format.mjs path traversal`
  collapsed into ONE block, so the traversal keyword from item 2 lent credit to the innocent
  `src/routes.mjs` mention in item 1 (`found: true` for a bug the review never attributed).
- **`detectDirectoryReads()` accepts an explicit `./` relative prefix** (`(?:\.\/)?` on both the
  wildcard and the bare-directory pattern), so `cat ./src/*` and `grep -rn TODO ./src` are caught as
  T2 forbidden probes like their `src/...` forms. Naming one file (`grep -n clampRange ./src/calc.mjs`)
  and unrelated relative paths (`./package.json`, `./test/calc.test.mjs`) stay non-probes.
- **Tests (187 → 189 total; 83 → 85 shootout).** `test/shootout.test.mjs` gained a contiguous
  numbered-item cross-credit regression (asserting `path_traversal` is `found: false`, and that a
  single item containing both the file and the keyword still earns it) and a `./`-prefix directory
  probe regression (positive and negative cases). Both were verified against the pre-fix scorer: they
  fail there for the intended reason and pass after the fix.
- **Verified:** `npm test` — **189 tests, 189 pass, 0 fail, 0 skipped** (26 audit-logger + 78
  workflow-automation + 85 shootout), fully offline.

### Added — reusable Model Shootout harness (`bench/shootout/`) plus the approved live 50-run sweep

A production measurement instrument, not a demo: 10 approved models x 5 tasks, every run in its own
isolated workspace, scored by hidden oracles the model never sees, with a layered budget fuse. This
is the evidence source for the model-lineup decisions in `Vision.md` / `Decisions.md`.

- **`bench/shootout/runner.mjs`** — CLI (`npm run shootout`) that plans, executes, meters, scores and
  reports the sweep. Per run: fresh directory, own `git init` + single initial commit, own
  `XDG_CONFIG_HOME`/`XDG_DATA_HOME`/`XDG_STATE_HOME`/`XDG_CACHE_HOME`, a minimal generated
  `opencode.jsonc` (no MCP, no plugins) and `--standalone`, plus a read-only copy of the OpenRouter
  credential into the isolated data dir; the live `~/.config/opencode` and `~/.local/share/opencode`
  are never written. The generated permission set allows only the run's workspace, denies
  `subagent`/`question`/`websearch`/`webfetch`/image generation, denies file tools and shell for
  `/root/**` outside that workspace, and denies the scratch roots (`/tmp`, `os.tmpdir()`) so no run
  can read a sibling run's already-installed oracle.
- **Four budget layers** (all independently tested): pre-run guard (`spent + reserve >= budget`
  refuses), preflight worst-case estimate vs `--per-run-cap-usd` (skips are recorded in `skipped`,
  never silently dropped), streaming per-event cost kill while the run is in flight, and post-run
  reconciliation before the next launch decision.
- **`bench/shootout/roster.mjs`** — the approved 10-model roster (4 workers + 6 frontier) with a
  catalog verifier: every `#variant` is re-checked against `/root/.cache/opencode/models.json`, and an
  unadvertised reasoning effort (e.g. `kimi-k3.1-pro#medium`) is dropped with a recorded
  `variantNote` rather than substituted. Workers run first, then frontier ordered by blended $/1M, so
  a mid-sweep budget stop consumes the cheapest slots first.
- **`bench/shootout/tasks.mjs`** — five self-contained fixtures, each with visible files, a hidden
  oracle installed only after the model exits, and a reference fix that proves the oracle is
  satisfiable: T1 `bugfix_precision` (cent-ledger drift + sliding-window boundary), T2
  `scope_discipline` (fix one function; two tempting out-of-scope files are a diff-scope and
  probe-detection trap), T3 `citation_honesty` (three real buried facts + two constants that do not
  exist), T4 `hard_multifile_debug` (coalescing cache rejection poisoning/size bound/TTL + batch retry
  queue error swallowing), T5 `code_review` (three planted bugs, two clean decoys, read-only tree).
- **`bench/shootout/scorers.mjs`** — JSONL event parsing, cost reconciliation (`reported` vs
  `estimated`), tool-error/step metrics, hidden-oracle + public-suite + anti-cheat scoring, diff-scope
  and forbidden-probe detection, citation and review rubrics, leaderboard aggregation. A run passes at
  score >= 0.9; a timeout stays a timeout even when the workspace had already reached a passing state,
  and never counts as solved.
- **Output artifacts** (gitignored): `REPORT.md`, `summary.json`, `config-snapshot.json` and, per run,
  `runs/<runId>.json` (the scored, sanitized record) plus `runs/<runId>/stdout.jsonl` (the raw event
  stream), so every score is auditable against the raw trace. `runs/<runId>/{repo,xdg}/` is the temp
  workspace and is deleted after scoring unless `--keep-temp` is passed; `run-console.log` exists only
  when the sweep's stdout was redirected there. (The original entry listed
  `runs/<runId>/{stdout.jsonl,run.json,repo/}`, which never matched what the runner writes — corrected
  in Wave D.)
- **Tests (104 → 187 total; 26 audit-logger + 78 workflow-automation + 83 shootout).** New
  `test/shootout.test.mjs` with **83 tests**
  covering roster/catalog drift, price ordering, budget guards and the streaming kill, isolated-config
  and workspace isolation (including that a sibling run's workspace and the harness sources are
  denied), JSONL parsing and cost reconciliation, each task's hidden oracle against its reference fix
  (and failing against the broken initial state), the scope/probe/anti-cheat/citation/review scorers,
  leaderboard math, report rendering and the `--dry-run` plan. Offline only: no live provider calls.
- **Live sweep executed (user-approved, 2026-11-22).** `npm run shootout -- --budget-usd 5.0
  --per-run-cap-usd 0.60 --timeout-sec 180 --concurrency 4` — **50/50 runs started, 0 skipped, 0 failed
  to launch**, stop reason `complete`, wall clock **11m49s**, **spend $2.6531 of the $5.00 hard cap**
  (largest single run $0.3874, under the $0.60 per-run cap), 46 `ok` + 4 `timeout`, 43/50 runs at or
  above the 0.9 threshold, 539 tool calls / 11 tool errors (10 isolation denials + 1 file-not-found) /
  462,373 input and 84,697 output tokens.
- **What the sweep measured (raw, nothing retried or hidden).** `tencent/hy4-flash` solved 5/5 for
  $0.0082 ($0.0016 per solved task) and `deepseek-v4.1-flash-1017` 5/5 for $0.0273; `gpt-6.2-sol`,
  `kimi-k3.1-pro` and `gemini-4-hydrogen` solved 5/5 at $0.23–$0.52. T2's scope/probe trap was passed
  by all 10 models (nobody's diff or tool trace escaped the allowed files). T3's trick premise cost
  only `claude-opus-5.5` a point (0.85 — it mentioned the non-existent `REDIS_BREAKER_THRESHOLD`
  without an explicit absent/unverified statement). On T5, eight models found all three planted bugs;
  `gpt-6-luna` missed the null-metadata crash (0.83), `minimax-m3.1-flash` found all three but also
  flagged all three clean decoys (0.70), and `claude-opus-5.5` found all three with one decoy false
  positive (0.90). Four 180s timeouts: `minimax-m3.1-flash__T1`, `qwen4-max__T4` and
  `gemini-4-neon__T1` had already reached a passing workspace when killed; `gemini-4-neon__T4` stalled
  168s after a `step_start` with no event and no retry and scored 0.30. Two upstream rate-limit retries
  hit `gpt-6.2-sol` (`__T1`, `__T4`); both recovered and still scored 1.00. Ten permission denials
  were recorded across 6 runs: eight models tried to stage a scratch verification script under `/tmp`
  (denied so no run can read a sibling run's workspace), one listed `bench/shootout/` where the hidden
  oracles live, and one tried to read the sweep's own `run-console.log` — the isolation wall engaging,
  reported per run rather than treated as clean.
- **Verified:** `npm test` — **187 tests, 187 pass, 0 fail, 0 skipped** (26 audit-logger + 78
  workflow-automation + 83 shootout; Wave D added 30 shootout regressions). `npm run shootout --
  --dry-run` prints the catalog check, the roster, all five tasks and a $2.9215 worst-case estimate for
  the 50-run sweep before any spend.
- **Residual, stated rather than papered over:** 11 of 539 tool calls (2.0%) errored — 10 permission
  denials (8 `/tmp` scratch-staging attempts, 2 harness peeks) plus 1 file-not-found on a test file the
  model assumed existed. Denying `/tmp` is correct for cross-run safety but does add friction for
  models that prefer to stage verification scripts outside the workspace; that friction is measured,
  not hidden. Timeouts are wall-clock limits rather than provider failures, and the roster's price
  snapshot is a point-in-time copy of the catalog, so cost-per-pass comparisons should be re-measured
  rather than quoted indefinitely.

### Fixed — Wave D: six blocking harness defects + provenance/artifact corrections in the Model Shootout

An independent Reviewer audited `bench/shootout/*` against all 50 raw 2026-11-22 transcripts and found
six defects that made the instrument either unsafe or unfair, plus stale provenance/artifact
documentation. Every fix below has a regression test; **zero live LLM calls** were made (all 30 new
tests are offline, and `artifacts/shootout-20261122/` was left byte-identical as the raw evidence).

- **Concurrent runs could overshoot the budget.** The worker loop only checked *money already spent*,
  so four workers could each pass the guard and then spend up to the per-run cap concurrently (a $1.00
  cap with $0.30 runs could reach $1.20). Every run now reserves its worst case (`perRunCapUsd`)
  *before* spawning, so `committed + inFlightReserved + safetyReserve <= budgetUsd` holds for every
  concurrent worker (`canReserveRun()`); the reservation is released and reconciled with the measured
  cost when the run finishes. Regression: 4 workers x $0.30 under a $1.00 cap start exactly 3, peak
  concurrency 3, spend $0.90, stop reason `budget`.
- **Mixed reported/estimated step cost discarded earlier estimates.** `extractMetrics()` (and the
  streaming `CostTracker`) treated "any step reported a cost" as "use reported cost only", quietly
  losing the token estimates of steps whose provider reported none. Cost is now summed **per step**:
  a step with a reported cost contributes that cost, a step with only tokens contributes its own
  estimate, and the run is labelled `reported` / `estimated` / `mixed`.
- **The child process inherited the whole parent environment.** Every model process now gets an
  allowlisted environment (`PATH`, `HOME`, `NODE_ENV`, `TERM`, `OPENROUTER_API_KEY`, the run's
  `XDG_*`) instead of all of the caller's secrets and tokens (`ALLOWED_CHILD_ENV`).
- **The copied credential was left behind.** `auth.json` was copied into each run's temp XDG data dir
  and stayed there after the run. It is now deleted as soon as the run finishes (even with
  `--keep-temp`), the temp workspace (`runs/<runId>/{repo,xdg}`) is deleted after scoring unless
  `--keep-temp` is passed, and only the sanitized run record plus `stdout.jsonl` remain.
- **An over-broad shell allow could override earlier denies.** The `*<workspace>*` bash/shell allow is
  a substring match on the command string, so a command that mentioned its own workspace could also
  reference `..` or `/root`. Parent-traversal denies (`*../*`, `* ..*`, `..`) and the
  `/root`/harness-source denies are now re-applied *after* the workspace allow (later rules win).
- **T1/T2/T4 prompts asked for a test command Node 22 cannot run.** `node --test test/` fails with
  `Cannot find module '<repo>/test'` on Node 22. The prompts now name the files
  (`node --test test/ledger.test.mjs`, `test/calc.test.mjs`, `test/pipeline.test.mjs`) and the fixture
  `package.json` uses `node --test test/*.test.mjs`.
- **`pathMatches()` credited look-alike citations.** Suffix/basename matching let
  `elsewhere/config.mjs` (or a bare `config.mjs`) satisfy a citation for `src/config.mjs`. Matching is
  now exact on the normalized repo-relative path. T3 also subtracts `fabricatedPenalty` (0.1) per
  citation to a file that does not exist, and honours a `clean_status` gate so a dirty or
  unverifiable workspace cannot reach 0.9 on citation credit alone.
- **T3's absence markers missed natural phrasings.** `no redis`, `there's no`, `not configured`,
  `neither … exists` (regex markers), `doesn't appear`, `nowhere in`, `not mentioned` and friends now
  count as an explicit absence. Re-scoring the archived `claude-opus-5.5__T3` transcript gives
  **1.00** (raw 0.85).
- **T5 matched globally instead of per finding, and punished clean sections.** Bug credit now requires
  the filename and the defect keywords inside **one finding block** (blank-line/heading-separated
  sections, with heading context carried to the blocks beneath), `missing` was added to the
  null/absent-metadata keywords, and decoy false positives are block-scoped, counted once per decoy,
  exempt in explicit negation/clean sections (`not flagged`, `clean`, `valid`, `no issue`, …) and
  require the decoy's identifier or a `file:line` into that file. Re-scoring the archived transcripts
  gives `gpt-6-luna__T5` **1.00** (raw 0.83) and `minimax-m3.1-flash__T5` **0.90** (raw 0.70).
- **A deleted `.git` was scored as a clean tree.** `gitStatusEntries()` returned `[]` for any git
  failure, so removing `.git` (or making `git status` fail) read as "read-only respected". It now
  fails closed with `{ clean: false, entries, error }`, and the read-only rubrics (T3, T5) score zero
  when `clean_status` is not true. The porcelain parse also stopped trimming the status column
  (`git(..., { trim: false })`), which had been shifting the first path (`src/x.mjs` → `rc/x.mjs`).
- **T2 wildcard probes went undetected.** `cat src/*`, `grep -rn TODO src`, `ls src` and `cat *.mjs`
  reached the forbidden files without naming them. `findForbiddenProbes()` now also flags
  whole-directory/glob reads when a forbidden file lives in that directory, while still ignoring
  single-file commands (`node --test test/calc.test.mjs`, `grep -n clampRange src/calc.mjs`).
- **The leaderboard hid failures and double-penalized timeouts.** `Capability` averaged completed runs
  only, so 3 solved + 2 timeouts could print `Capability 100`; `stopDiscipline` subtracted the timeout
  count twice (once as a failure, once as a timeout). `Capability` is now the mean over **all attempted
  runs** (a failed run contributes its workspace score capped just below the pass threshold, never a
  pass), `Solved` is `passed/attempted`, every attempted task keeps its effective score in the matrix,
  and each failed run is penalized once.
- **Provenance and artifacts were documented wrong.** `config-snapshot.json` now records the template
  *and* the same rules resolved for a run workspace, the git HEAD commit/branch/dirty flag, the catalog
  check and the in-flight admission rule, instead of only the literal `<workspace>` template;
  `summary.json` carries `git.commit` and `catalogCheck`; `verifyAgainstCatalog()` runs before live
  runs (a readable catalog that contradicts the roster refuses to start with a one-line error and exit
  code 2, a missing catalog is recorded as a warning). `REPORT.md`/README now describe the real artifact
  layout (`runs/<runId>.json` + `runs/<runId>/stdout.jsonl`, temp workspace only with `--keep-temp`) and
  state honestly that OpenCode permission rules are command-string filters, **not an OS container
  sandbox** (the stale "/tmp residual" sentence is gone).
- **Documented audit trail.** README gained an "Independent Reviewer Transcript Audit" table beside the
  2026-11-22 sweep table: raw vs audited scores (Opus T3 0.85 → 1.00, Luna T5 0.83 → 1.00, MiniMax T5
  0.70 → 0.90), the audited 46/50 pass count, and the audited leaderboard — with the raw table kept as
  recorded.
- **Tests (157 → 187; 53 → 83 shootout).** 30 new offline regressions: concurrent 4-worker reservation
  under a $1.00 cap, mixed per-step cost accounting (metrics + streaming tracker), exact-path citation
  matching, the Opus-style absence phrasing, natural absence markers, the Luna-style `Missing metadata`
  finding, the MiniMax-style `Not flagged` decoy exemption and per-block cross-section rejection,
  deleted-`.git` fail-closed + dirty-T3 gate, wildcard/directory probes, timeout-inclusive capability
  and stop discipline, the allowlisted child environment, `auth.json` deletion with and without
  `--keep-temp`, the resolved config snapshot and report wording, git provenance in `summary.json`, the
  roster/catalog refusal path, the post-allow traversal denies, and the Node-22-safe prompt commands.

### Fixed — Wave 8: three final reviewer edge cases (evidence attribution, in-target symlinks, document-only merge)

The last three surgical defects from the independent reviewer's final audit. No config file changed;
three modules, three regression tests and documentation. Zero paid LLM calls.

- **Model-routing and dead-skill evidence now require an attributed session.** `src/rsi-prune.mjs`
  counts a project for a model's or a skill's evidence only when the *same* record also carries an
  attributed session — the same rule `recordEvidence()` already applied to permission/shell
  evidence. A session-less `session.usage.updated` / `session.skill.activated` record from a second
  project could previously supply the second project that unlocked a model-routing or dead-skill
  proposal while contributing no history at all.
- **An in-target symlink at a sync destination is refused, never followed.** `scripts/sync-global.mjs`
  now `lstat`s the original lexical destination path before resolving it and refuses when that
  destination itself is a symlink, so `opencode.jsonc -> victim.json` can no longer overwrite
  `victim.json`; the destination path is not replaced by the link's referent. Links that escape the
  target keep the existing "symlink outside the sync target" error.
- **`unwrapResolvedConfig()` merges only `type:"document"` entries.** The fallback that merged any
  non-document entry carrying a non-empty `info` is gone, so a fully-populated `{type:"directory"}`
  blob cannot pose as resolved config and pass `validateResolvedConfig()`. A document entry in the same
  array still resolves and the directory's `info` is ignored.
- **Regression tests (101 → 104 total, 75 → 78 workflow-automation).** "session-less records cannot
  add a project to model-routing or dead-skill evidence" (5 attributed alpha records + 1 session-less
  beta record; the global guard is satisfied by alpha + gamma, yet both proposals are withheld with
  `{distinctProjects: 1, sessions: 5}`); "refuses an in-target symlink at the sync destination without
  following it" (link refused, `victim.json` untouched, no `.bak-` taken, dry run refused too); "a
  non-document entry carrying info is never merged as resolved config" (directory-only blob rejected,
  document in the same array still resolves). Each new test was re-run against the pre-fix code and
  failed for the intended reason: 2 projects instead of 1, a missing refusal, and a directory blob
  being accepted.
- **Verified:** `npm test` — **104 tests, 104 pass, 0 fail, 0 skipped** (26 audit-logger + 78
  workflow-automation); `npm run verify -- --schema --live` against the real `~/.config/opencode/` —
  **Verify PASS, exit 0**, 14 PASS lines, 0 FAIL, one WARN (`mcp list did not show pi_search`, the
  known 2.3.2 display gap).

### Fixed — Wave 7B: `validateResolvedConfig()` now matches OpenCode 2.3.2's real `debug config`

Closes the one open defect from Wave 6B. No config file changed (the live config was already correct);
only the verifier, its regression tests and documentation. Zero paid LLM calls.

- **Array-of-documents output is unwrapped.** `opencode --standalone debug config` (2.3.2) prints an
  array of layered entries — `{type:"document",path,info:{…}}` plus `{type:"directory",path,info:{}}`
  entries — not a single object. The new `unwrapResolvedConfig()` returns a plain object unchanged and
  otherwise merges the `info` objects of the `type:"document"` entries in output order (later document
  wins per top-level key; keys only an earlier document defines survive; empty `directory` infos
  contribute nothing).
- **`model` accepts both spellings, still one catalog.** The new `resolvedModelId()` normalizes the
  string form (`openrouter/google/gemini-4-neon#high`) and the resolved object form
  (`{providerID:"openrouter",model:"google/gemini-4-neon",variant:"high"}`) to one
  `provider/model#variant` id, and both are held to the OCW-03 `APPROVED_MODELS` catalog — an
  unapproved normalized object is rejected exactly like an unapproved string, and a model object
  missing `providerID`/`model` is rejected as "no model".
- **Nothing was loosened.** `{}`, `[]`, `[{"type":"directory","info":{}}]`, `null`, a missing model,
  a missing `mcp.servers.pi_search` (which must be `type: "local"` with `codemode` not explicitly
  `false`) and a missing `audit-logger` plugin all still fail, each with its own message.
- **Regression tests (72 → 75 workflow-automation).** "resolved debug config accepts the real 2.3.2
  array-of-documents shape" (exact live fixture, normalized model object, document merge precedence,
  directory entries ignored), "resolved debug config rejects document-less and unapproved resolved
  shapes" (`[]`, directory-only, `{}`, `null`, missing model/`pi_search`/`audit-logger`, non-local
  `pi_search`, `codemode: false`, unapproved normalized model object and unapproved string), and
  "binary runs accept the real 2.3.2 array-shaped debug config end to end" (stub binary printing the
  real array shape passes `runBinaryChecks()`, a directory-only stub fails).
- **Verified:** `npm test` — **101 tests, 101 pass, 0 fail, 0 skipped** (26 audit-logger + 75
  workflow-automation); `npm run verify` (isolated copy + real binary) — **Verify PASS, exit 0**;
  `npm run verify -- --schema --skip-binary` — **Verify PASS, exit 0**; `npm run verify -- --schema
  --live` against the real `~/.config/opencode/` — **Verify PASS, exit 0** with 14 PASS lines, 0 FAIL
  and one WARN (`mcp list did not show pi_search`, the known 2.3.2 display gap). OCW-09's "`npm run
  verify` passes" is therefore met end-to-end for the first time.

### Security/correctness hardening — Wave 6B (verifier + path-safety follow-ups)

Reviewer follow-ups on the Wave 4B/6A fixes. Zero paid LLM calls. Every fix has a regression test in
`test/workflow-automation.test.mjs` (**61 → 72** tests), and the hardened config was then re-synced
into the live `~/.config/opencode/` install.

- **Derived total-fuse overflow rejected (OCW-07).** `strictPositiveNumber()` now validates its
  `fallback` argument with the same rule as a caller-supplied value. The cumulative fuse defaults to
  `maxUsdPerSession * DEFAULT_MAX_USD_TOTAL_MULTIPLIER`, which is `Infinity` once `maxUsdPerSession`
  is near `Number.MAX_VALUE`; that would silently disable the fuse. Such a run now fails to start
  with `InvalidSupervisorOptionError` instead.
- **Absolute/relative workspace attribution fails closed.** `pathMatchesWorkspace()` no longer falls
  through to basename equality when exactly one side is absolute: a bare label (`shared`) cannot be
  proven to be `/work/alice/shared` rather than `/work/bob/shared`, so the mismatch never matches in
  either direction. Basename comparison survives only for relative-vs-relative, and a bare project
  label is still never evidence for an absolute workspace.
- **Session-required per-proposal RSI evidence.** `recordEvidence()` counts a project/session pair for
  a proposal only when the record carries an attributed session. Previously a session-less record
  (bare `plugin.loaded`, `shell.before` with no session) from a second project could supply the
  second project that unlocks a global pruning proposal while contributing no history at all.
- **Dangling-symlink-safe `realpathDeep` + `O_NOFOLLOW` report writes.** `realpathSync` throws on a
  dangling link and the old fallback re-appended the leaf literally, so
  `safe/link -> /root/.pi/missing/report.txt` resolved to `safe/link`, passed the protected-root
  check, and only then wrote into Pi's tree. Both `src/rsi-prune.mjs` and `scripts/sync-global.mjs`
  now resolve segment by segment with `lstat`/`readlink` (bounded at 40 hops), so a link is resolved to
  its real destination even when that destination does not exist yet. `writeRsiReport()` additionally
  opens the report `O_NOFOLLOW` (mode `0600`), closing the check-then-open race.
- **Random `O_EXCL|O_NOFOLLOW` atomic writes in `sync-global`.** `atomicWrite()` used a predictable
  `<destination>.tmp` name, so an attacker-planted symlink at that name could be written through. The
  temp name is now cryptographically random (`.<basename>.<32 hex>.tmp`) and opened
  `O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW`; the destination is `lstat`-checked before creating the temp
  file and again before `renameSync`, and `rename` replaces a link rather than following it. A
  regression test plants `opencode.jsonc.tmp` as a symlink to a file outside the target and asserts
  the outside file is untouched, the link survives as a link, and no temp files leak.
- **`verify-setup` OCW-03 model allowlist.** Model pinning was shape-only (`provider/model` regex), so
  `not-a-catalog/model` passed. An explicit `APPROVED_MODELS` catalog (Gemini 4 Neon, DeepSeek V4.1
  Flash 1017, Claude Sonnet 5.5 / Opus 5.5 / Fable 5.2, GPT-6.2 Sol, GPT-6 Luna) is now enforced for
  the eight roster agents, for **every other configured agent**, and for the top-level `model`;
  `#variant` suffixes and the `openrouter/` routing prefix are normalized away before comparison.
- **`verify-setup` resolved-config check.** A new `validateResolvedConfig()` gate refuses a parsed but
  empty/partial `debug config` result: `{}` is valid JSON and would otherwise prove nothing. It
  requires a resolved `model`, `mcp.servers.pi_search` and an audit-logger plugin entry. It assumed a
  single config object and therefore mismatched the real CLI output — the open defect fixed in Wave 7B
  (above).
- **`verify-setup` `.env.example` bypass test.** The verifier now resolves `cat .env # .env.example`
  and `cat .env; cat .env.example` on both `shell` and `bash` and requires ask/deny, and requires all
  four file-path actions (`read`/`edit`/`write`/`patch`) to allow `.env.example`, so Wave 6A's fix is
  enforced instead of merely described.
- **`verify-setup` authentic `plugin.loaded` check.** Audit evidence now only counts when the record
  names this workflow's plugin (`plugin: "opencode-workflow-audit"`) **and** proves
  `loggingEnabled: true`; a bare `{"event":"plugin.loaded"}` line, a foreign plugin id, a
  missing/unknown logging flag, or a runtime-disabled logger is a hard failure. Binary runs still
  reject historical evidence and now also reject an empty resolved config.
- **Live re-sync.** `npm run sync` on 2026-11-22 09:59 UTC backed up the previous live config to
  `opencode.jsonc.bak-2026-11-22T09-59-40-970Z` and installed the hardened `config/opencode.jsonc`;
  `~/.config/opencode/opencode.jsonc` is byte-identical to the repository copy (sha256 `23fd8a42…`),
  `AGENTS.md` was already identical, and no `service.json` was present to rotate. This makes Wave 6A's
  removal of the `bash`/`shell` `*.env.example` allow rules live.
- **Verified:** `npm test` — **98/98 PASS** (26 audit-logger + 72 workflow-automation);
  `npm run verify -- --schema --skip-binary` — **PASS** (11 offline invariants + live schema fetch,
  `.env protection: pass (read, edit, write, patch, shell, bash)`).
- **Open defect reported here — FIXED in Wave 7B (above).** `validateResolvedConfig()` expected a
  single config object with a string `model`, but `opencode --standalone debug config` (2.3.2) prints
  an array of three entries — `{type:"document",path,info:{…}}` plus two `{type:"directory"}`
  entries — and the resolved `model` inside `info` is the object
  `{providerID:"openrouter",model:"google/gemini-4-neon",variant:"high"}`. Result:
  `FAIL debug config did not resolve to a JSON object`, with every other live check passing and
  `debug config`/`debug agents`/`mcp list` exiting 0. The config was never at fault. Wave 7B unwraps
  the array and normalizes the model object, so `npm run verify -- --schema --live` now ends **Verify
  PASS, exit 0**.

### Security/correctness hardening — Wave 6A (`.env.example` shell/bash bypass)

Reviewer Part A's remaining blocker. Zero paid LLM calls; no live config was modified.

- **`*.env.example` is no longer allowed on command surfaces.** `config/opencode.jsonc` declared
  `{ "action": "bash"|"shell", "resource": "*.env.example", "effect": "allow" }`. A `bash`/`shell`
  resource is the whole command string, not a path, so any command *ending* in `.env.example` matched
  the trailing-glob allow while still reading the real file: `cat .env # .env.example` and
  `cat .env; cat .env.example` both bypassed the `.env` ask (comment and compound-command bypass).
  Both rules are removed. The `*.env.example` `allow` stays for `read`/`edit`/`write`/`patch`, whose
  resource is a single file path, and a config comment records the reason so the rules are not
  re-added later.
- **Shell/bash behaviour is now fail-closed.** Any `bash`/`shell` command mentioning `.env*` falls
  through to the command-glob `ask` rules (`*.env*`, `* .env*`, `*/*.env*`, `*.env *`, `*.env`), so
  `.env.example` templates remain readable/writable through the file tools while every shell command
  that touches them is confirmed first.
- **No verifier or test change was required.** `npm run verify` still requires `.env.example` to
  resolve to `allow` for the `read` action and `.env` to resolve to `ask`/`deny` for
  read/edit/write/patch/shell/bash; both hold. `npm test` and `npm run verify -- --schema` re-run
  PASS against the tightened ruleset (see Verified below).
- **Docs realigned.** `Vision.md` OCW-02 now states that the `.env.example` auto-allow is limited to
  the file-path tools while shell/bash fails closed, and its live-status item no longer claims the
  Wave 4A re-sync is outstanding; `README.md` states the same in its status, verify, permission and
  Wave 4A/4B sections.
- **Verified:** `npm test` — **87/87 PASS** (26 audit-logger + 61 workflow-automation, unchanged);
  `npm run verify -- --schema --skip-binary` — **PASS** with the live schema fetch, reporting
  `.env protection: pass (read, edit, write, patch, shell, bash)` and `.env.example` still allowed for
  `read`. Zero paid LLM calls.
- **Now live.** The fix was repository-only when it landed; the 2026-11-22 09:59 UTC `npm run sync`
  installed the corrected config, so `~/.config/opencode/opencode.jsonc` no longer carries the
  `bash`/`shell` `*.env.example` allow rules (previous live copy preserved at
  `opencode.jsonc.bak-2026-11-22T09-59-40-970Z`). See Wave 6B above for the post-sync verification
  result, including the one open verifier defect.

### Security/correctness hardening — Wave 4B (reviewer Part B)

Reviewer Part B's blocking findings are fixed with regression tests. Zero paid LLM calls. The
hardened config was then re-synced into the live `~/.config/opencode/` install.

- **Supervisor cumulative spend fuse (`--max-total-usd`, default $30).** The supervisor now meters
  spend per *accounting epoch*: a `fresh_session` or an agent escalation finalizes the finished epoch
  into `finalizedSpentUsd` and starts a new epoch from the provider's cumulative session cost, and
  the running epoch is measured against `--max-usd` (default 15). The cumulative total is checked
  against `--max-total-usd` (default `maxUsdPerSession * 2`) on every usage update and again before
  any semantic decision. Previously a fresh session could reset the only counter, so a long run had
  no real total ceiling.
- **Strict positive-number validation.** `strictPositiveNumber()` / `strictPositiveInteger()` reject
  `NaN`, `Infinity`, zero, negatives and non-integer checkpoint/window/threshold values with
  `InvalidSupervisorOptionError`; an unset/empty value still takes the default. A NaN fuse is a
  disabled fuse, so refusing to start is the fail-closed behaviour.
- **`--memory-model`.** The consolidation model is now selectable (`--memory-model ID`) and defaults
  to the supervisor model, then `deepseek/deepseek-v4.1-flash-1017` (`DEFAULT_MEMORY_MODEL`).
- **Native tool labels.** `toolLabel()` prefers `data.native.name` (e.g. `apply_patch`) before
  `data.tool`, `data.name` and `data.id`, so supervisor summaries and error-window decisions no
  longer collapse to "tool" or an opaque id.
- **Terminal execution checkpoints.** `session.execution.succeeded` / `failed` / `interrupted` are now
  decision checkpoints (`execution_succeeded` / `execution_failed` / `execution_interrupted`).
  `failed` counts as an error signal; `interrupted` is terminal but not an error (the supervisor may
  have interrupted the session).
- **`Error.cause` sanitized (zero key leak).** `sanitizeErrorCause()` rebuilds a cause carrying only
  the redacted message, name and code; `request`, `config`, the original object and any further cause
  chain are dropped. `OpenRouterError` never forwards the caller's cause. A regression test puts the
  API key in the upstream message/code and in `request.headers.authorization` and asserts the key is
  absent from `String(cause)`, its message, code, stack and `JSON.stringify`.
- **Canonical full-path workspace attribution.** `memory-consolidate` (and the shared readers) now
  match workspaces by canonical absolute path — exact equality or child containment — so
  `/work/alice/shared` and `/work/bob/shared` are distinct projects; the basename fallback survives
  only for relative paths, and a bare project label is never treated as evidence for an absolute
  workspace. This closes the basename-collision path that could attribute another project's tool
  calls (and secrets) to this project's memory and RSI proposals.
- **Empty-file `.bak` backup.** `MEMORY.md` is backed up on *existence*, not content truthiness, so a
  deliberately truncated 0-byte file is preserved before being replaced.
- **Per-proposal RSI guard.** Every pruning proposal carries its own `evidence`
  (`distinctProjects`, `sessions`, `forced`) and is gated independently on the arXiv:2611.03219
  threshold (2 projects + 5 sessions). Refused proposals are emitted under `pruning.withheld` with a
  `withheldReason` and a warning instead of being silently dropped; `--force` still overrides but
  records `forced: true` and warns. A single-project pattern can no longer be proposed globally just
  because an unrelated second project exists.
- **Canonical symlink-safe `--out`.** `rsi-prune` canonicalizes the report path through `realpathSync`
  (walking existing ancestors and re-appending missing segments) and refuses the filesystem root,
  `/root/.pi`, `/root/pi-projects/pi-workflow-tools`, `~/.config/opencode` and this repository's
  `config/`, so a symlink planted in a writable directory cannot redirect the report.
- **`sync-global` canonical protection for both trees.** `assertSafeTarget()` checks the literal path
  and the `realpathSync` of both `/root/.pi` and `/root/pi-projects/pi-workflow-tools` (plus the
  source repo as a destination), and every write/move/delete inside the target is re-canonicalized
  so a `v1-disabled` symlink escaping the target is refused.
- **`verify-setup` strict invariants.** Binary runs now hard-fail when no OpenCode log exists or when
  no fresh `plugin.loaded` record was written to that run's own isolated audit directory
  (historical evidence is never accepted), and offline validation enforces OCW-02/03/04: bounded
  `compaction.keep.tokens`, `tool_output` and `media.image` limits; every roster agent pinned to a
  `provider/model` id; primary/subagent modes with bounded subagent steps; read-only roles denying
  `edit`/`write`/`patch`; and `.env` protected on read/edit/write/patch/bash/shell with
  `.env.example` re-allowed.
- **Tests added** in `test/workflow-automation.test.mjs` (42 → 61): sanitized `Error.cause`, distinct
  absolute workspaces sharing a basename, empty-`MEMORY.md` backup, non-finite/non-positive option
  rejection, `fresh_session` epoch accounting with the total fuse still firing, native tool labels +
  terminal execution checkpoints, per-proposal withholding, `--out` protected/symlink refusal,
  pi-workflow-tools symlink refusal, and missing-log / missing-fresh-`plugin.loaded` verify failures.
- **Live re-sync.** `npm run sync` backed up the previous live config to
  `opencode.jsonc.bak-2026-11-22T09-47-04-566Z` and installed the hardened `config/opencode.jsonc`
  (including Wave 4A's `.env` ask rules for read/edit/write/patch/bash/shell and the `.env.example`
  re-allow); `AGENTS.md` was already identical and no `service.json` was present.
- **Verified:** `npm test` — **87/87 PASS** (26 audit-logger + 61 workflow-automation);
  `npm run verify -- --schema --live` — **PASS** against the live `~/.config/opencode/` install.

### Security/correctness hardening — Wave 4A (reviewer Part A)

All five blocking reviewer findings are fixed with fail-closed behaviour and a regression test for
each one. Zero paid LLM calls; no live config was modified (re-sync happens after 4A + 4B pass).

- **`.env` permission bypass closed (OCW-02).** `config/opencode.jsonc` now keeps the baseline
  `allow *` first, then asks on `.env` / `.env.*` for **read, edit, write, patch** and for
  **bash/shell** command globs (`*.env*`, `* .env*`, `*/*.env*`, `*.env *`, `*.env`), and then
  re-allows `*.env.example` on all six surfaces so later-wins ordering keeps templates usable.
  Removed the stale comment claiming the audit plugin would be created in Wave 2B.
- **Bare credential assignments redacted.** `redact.js` now matches generic `KEY=VALUE` /
  `KEY: value` assignments and quoted JSON key/value pairs, filtering through `isSensitiveKey()`.
  `PASSWORD=hunter2`, `TOKEN=secretvalue`, `API_KEY=secretvalue`, `OPENAI_KEY=supersecretvalue`,
  `{"apiKey":"supersecretvalue"}` and `'clientSecret': '…'` are all replaced; `MAX_TOKENS=4096`
  still survives. `isSensitiveKey()` treats provider-specific `*_KEY` names as credentials while
  excluding `key`/`publicKey`/`sortKey`/etc.
- **Redact before truncation (PEM fail-closed).** `redactString()` no longer truncates first. A
  complete PEM block is replaced with `[REDACTED PRIVATE KEY]`; an unclosed
  `-----BEGIN … PRIVATE KEY-----` block (or a header cut mid-way) replaces the whole tail with
  `[REDACTED_PRIVATE_KEY]`; only then is the 4,000-character cap applied. A key body straddling the
  boundary can no longer leak a `SECRETKEYMATERIAL` prefix.
- **`Error.name` redacted and capped** in both `redact.js` (deep walk) and `index.js`
  (`summarizeStructuredError`), matching `Error.message`.
- **Revoked Proxy safety.** Every `instanceof`, `Array.isArray`, property read and `Object.keys` in
  `redact()` is individually guarded; a revoked Proxy or throwing getter degrades to
  `[Unreadable]` instead of throwing out of the redactor. `describeError()`/`summarizeError()` were
  hardened the same way.
- **Audit writer fails closed on permissions (0700/0600).** `createAuditLog()` verifies the audit
  directory after `chmod` and the day file after `fchmod`; if either mode cannot be confirmed it
  disables logging instead of appending to a world-readable file. Regression test injects a
  filesystem seam whose `fchmodSync` is a no-op.
- **Symlink / FIFO / non-regular-file protection.** The audit directory must pass `lstat().isDirectory()`
  and not be a symlink. The daily JSONL file is pre-checked with `lstat`, opened with
  `O_CREAT | O_APPEND | O_WRONLY | O_NOFOLLOW | O_NONBLOCK`, then verified with
  `fstat().isFile()` and `fchmodSync(fd, 0o600)` before any write. Symlinks, FIFOs and directories at
  the day path are refused and targets stay untouched.
- **Corrected cross-process atomicity comment.** The writer now documents what it actually does:
  one serialized buffer per record, synchronous `writeSync` with `O_APPEND`, and a short-write loop;
  there is no cross-process lock, so a short write completed by a second append could interleave.
- **Bounded teardown.** Each `registration.dispose()` is raced against a 1,500 ms timeout
  (`DISPOSE_TIMEOUT_MS`); a hang is recorded as `plugin.error` / `cleanup.dispose.timeout` and the
  remaining hooks are still disposed. The timeout record is deliberately ref'd only while waiting.
- **Docs corrected.** `Vision.md` OCW-03 now names both approved System-1 supervisor options
  (`openai/gpt-6-luna` and `deepseek/deepseek-v4.1-flash-1017`, DeepSeek default); `Decisions.md`
  removes the stale "Wave 2B/2C not implemented" gap, clarifies that the OpenCode catalog drives
  local cost accounting while provider billing is authoritative, labels the driver/escalation claims
  as observed/reported, and records the Wave 4A hardening decisions; `README.md` documents the
  hardened permissions, writer and redaction behaviour.
- **Tests added** in `test/audit-logger.test.mjs` (18 → 26): bare assignments and textual JSON,
  4,000-char truncated PEM, `Error.name`, revoked Proxy, symlinked/FIFO daily paths, unverifiable
  0700/0600 modes, and a hanging `dispose()`. `node --test test/audit-logger.test.mjs` — **26/26
  PASS**; `npm test` — **87/87 PASS** in the current tree; `npm run verify -- --schema` — **PASS**.

### Added — Wave 2A (scaffold)

- **Repository scaffold.** `package.json` as ESM (`"type": "module"`, Node >= 22) with `test`,
  `sync` and `verify` script slots; dependencies `@opencode/plugin@2.3.2` and
  `@opencode/client@2.3.2` installed via npm (lockfile committed in the same change set later).
- **`config/opencode.jsonc`** written against the OpenCode v2.3.2 schema
  (`https://opencode.ai/config.json`):
  - `model: openrouter/google/gemini-4-neon#high`, `default_agent: build`
  - `compaction: { auto: true, background: true, buffer: "20%", keep: { tokens: 15000 } }`
  - `tool_output: { max_lines: 2000, max_bytes: 51200 }`
  - `media.image: { auto_resize: true, max_width: 2000, max_height: 2000, max_base64_bytes: 5242880 }`
  - ordered `permissions` array: baseline allow, `ask` for destructive local/remote/publishing/
    infrastructure/database commands (declared for both `bash` and `shell` action names), `ask` for
    `.env`/key reads and edits, `allow` for `*.env.example`
  - `agents`: `build`, `plan` (primaries); `worker` (DeepSeek V4.1 Flash 1017), `reviewer` and
    `fact-checker` (Claude Sonnet 5.5), `escalate-opus` (Claude Opus 5.5), `escalate-fable`
    (Claude Fable 5.2), `alt-reviewer` (GPT-6.2 Sol) as subagents with bounded `steps` and
    write denials for read-only roles
  - `mcp.servers.pi_search` (local, `codemode: true`, SearXNG + decision-model environment)
  - `plugins: ["/root/pi-projects/opencode-workflow/plugins/audit-logger"]`
- **`config/AGENTS.md`** — lean global rules, 2,269 characters: grounded claims with explicit
  references or an `unverified` label, mandatory independent cross-vendor fact-check, two-line
  `Intent:`/`Check:` progress updates, primary-agent auto-routing (worker → escalate-opus →
  escalate-fable → reviewer/alt-reviewer), Git and secret rules, and a rule banning GPT-6.1 Terra.
- **`Vision.md`** — authoritative destination, `OCW-01`..`OCW-09` requirements, non-goals (no
  pi-search replacement, no GPT-6.1 Terra, no dumb hard-cutoff loops), production definition of done.
- **`Decisions.md`** — language exception rationale (TypeScript/ESM required by the OpenCode v2
  plugin/client API; `pi-search` stays Rust; no gratuitous polyglot), model lineup table with
  catalog-verified context/cost/variants and cited primary sources, outer-loop architecture
  rationale (thin `@opencode/client` supervisor, semantic progress-vs-spin, `MEMORY.md` <= 2,500
  chars, weekly RSI pruning guard per arXiv:2611.03219), and the config shapes verified against the
  2.3.2 binary.
- **`.gitignore`** — `node_modules/`, artifacts, local overrides, `.env*` (with `!.env.example`).
- **`README.md`** — layout, requirements, install, script status, manual verification recipe,
  safety notes.

### Verified during Wave 2A (zero paid LLM calls)

- `opencode debug config` normalizes `openrouter/google/gemini-4-neon#high` to
  `{ providerID: "openrouter", model: "google/gemini-4-neon", variant: "high" }`; the `high` variant
  exists in the catalog with `reasoning.effort: high`.
- `opencode debug agents` shows the configured agents with merged permission rules; config rules
  apply after built-in defaults, so `.env` protection is re-declared last in the array.
- Every pinned model ID resolves in the local catalog (`client.model.list`), including
  `openrouter/openai/gpt-6.2-sol`.
- A stub plugin at a temp path default-exporting `Plugin.define({ id, setup })` loads and receives
  `context.app = { name: "cli", version: "2.3.2" }`.
- Client access works with `OpenCode.make({ baseUrl, headers })` using Basic auth
  (`opencode:<password>` printed by `opencode serve`).

### Known gaps

- `plugins/audit-logger` does not exist yet: OpenCode logs `failed to load plugin ... ENOENT` at
  startup until Wave 2B lands. *(Superseded by Wave 2B below.)*
- `scripts/` and `test/` do not exist yet, so `npm test`, `npm run sync` and `npm run verify` fail.
  *(Superseded by Wave 2B/2C below.)*
- MCP: `client.mcp.list()` returned an empty list in isolated runs even with `pi_search` configured
  and decoded correctly. Materialization looks session/location-driven; confirm during Wave 3.
  *(Addressed in Wave 3A below.)*
- Benchmark percentages quoted from the Wave 1 audit are reported, not re-verified in this session;
  the Wave 1 DeepSeek cost figure (`$0.02/$1.00`) disagrees with the local catalog (`$0.15/$0.60`).
- The repository is not yet under Git version control: `git init` is blocked for the implementer
  role, and the architect owns repository creation and commits.

### Not done (planned)

*(All three waves below were subsequently implemented — see the Wave 2B, Wave 2C and Wave 3A
sections that follow. These lines are kept as the original plan of record.)*

- **Wave 2B** — `plugins/audit-logger` (tool/permission/session audit log with secret redaction,
  non-blocking failure handling, tests) plus `scripts/sync.mjs` and `scripts/verify.mjs`.
- **Wave 2C** — outer-loop System-1 Supervisor on `@opencode/client` (semantic progress-vs-spin,
  bounded `MEMORY.md`, weekly RSI pruning guard) with tests.
- **Wave 3** — live activation in `~/.config/opencode` alongside untouched Pi, MCP connectivity
  confirmation, and a rehearsed rollback.

### Added — Wave 2B (audit plugin, scripts, tests)

- **`plugins/audit-logger/`** — OpenCode v2.3.2 plugin (`Plugin.define({ id: "opencode-workflow-audit" })`):
  append-only JSONL, one file per UTC day, mode 0600 in a 0700 directory; `plugin.loaded` /
  `plugin.stopped`; hooks for `session.prompt`, `tool.execute.before/after` (bounded `callId`
  timing map, 2000 entries), `permission.evaluate`, `shell.create.before` (command/cwd/timeout/shell
  only — never env values); an abortable event subscriber for 12 event types
  (`session.execution.*`, `session.usage.updated`, `session.idle`, `session.compaction.*`,
  `permission.asked/replied`). Records are capped at 64,000 chars, tool results are summarized
  instead of dumped, and every hook/write is wrapped: logging failure disables logging only.
- **`plugins/audit-logger/redact.js`** — structural redaction of credential-named keys and `env`
  maps plus textual redaction (Bearer/Basic, `sk-*`, GitHub/Slack/AWS/Google tokens, JWTs, PEM
  blocks, data URLs, URL userinfo, `KEY=value`), with depth/node/length bounds.
- **`scripts/sync-global.mjs`** (`npm run sync`) — installs `config/*` into `~/.config/opencode`,
  rotates an exposed `service.json`, moves legacy v1 files to `v1-disabled/` (never deletes),
  timestamped backups of overwritten files, idempotent, `--dry-run`, refuses `/root/.pi`.
- **`scripts/verify-setup.mjs`** (`npm run verify`) — strict JSONC parser, config invariants
  (Terra ban, `pi_search` + codemode, 8 agents, permission ordering), AGENTS.md ceiling, isolated
  `XDG_CONFIG_HOME` run of `opencode --standalone debug config|agents|mcp list`, plugin-load-error
  log inspection, optional `--schema`.
- **`test/audit-logger.test.mjs`** — 18 tests at Wave 2B (redaction, bounds, hooks, events,
  teardown, real binary load); 26 after Wave 4A added the hardening regressions.

### Added — Wave 2C (supervisor, memory, RSI guard)

- **`src/supervisor.mjs`** (`npm run supervise`) — thin `@opencode/client` System-1 outer loop:
  milestone-by-milestone sessions from `PLAN.md`, semantic decision checkpoints
  (`continue`/`steer`/`escalate_opus`/`escalate_fable`/`fresh_session`/`complete`/
  `pause_for_human`), no turn/token cutoffs, a `--max-usd` spend fuse, five-line pause notification
  (stdout, `notifications.log`, optional webhook), every decision appended to `supervisor.jsonl`,
  milestone marking, and `MEMORY.md` consolidation on completion.
- **`src/memory-consolidate.mjs`** (`npm run consolidate`) — `MEMORY.md` at most 2,500 characters:
  one compression retry then deterministic section-preserving truncation, atomic write with `.bak`
  backup, refuses empty model output, and the shared tolerant audit-JSONL readers used by the
  supervisor and pruner.
- **`src/rsi-prune.mjs`** (`npm run prune`) — read-only weekly RSI review (tool/model error rates,
  permission blocks, shell friction, AGENTS.md size, Terra scan, dead skills) with the
  multi-project catastrophic-forgetting guard (2 projects + 5 sessions, arXiv:2611.03219).
- **`src/openrouter-client.mjs`** — redacting OpenRouter client (timeouts, no key in any error).
- **`test/workflow-automation.test.mjs`** — offline suite for the above plus sync/verify.

### Fixed — Wave 3A (scripts, fixtures, JSONL schema integration)

- **`package.json` scripts are now real:** `test` → `node --test test/*.test.mjs` (Node 22 does not
  accept a bare directory), `sync` → `scripts/sync-global.mjs`, `verify` → `scripts/verify-setup.mjs`,
  and new `prune`, `consolidate`, `supervise` entries. Previously `npm test`/`npm run sync`/
  `npm run verify` pointed at files that did not exist.
- **Fixture fix:** the rsi-prune fixture in the "reports tool/model error rates, permission blocks,
  and shell friction deterministically" test used `sessionsPerProject: 2` (4 sessions), which the
  5-session forgetting guard correctly refuses; it now uses 3 sessions per project (6 sessions).
- **Wave 2B → Wave 2C schema integration** (both `src/memory-consolidate.mjs` and `src/rsi-prune.mjs`
  now parse the plugin's real record shapes):
  - Session → workspace/project attribution pass, so `tool.before`/`tool.after`/`shell.before`
    (which carry no `location.directory`) are no longer dropped by a workspace-scoped read and are
    no longer reported as an `unknown` project.
  - `tool.before` + `tool.after` pairs are counted once (terminal record wins) instead of doubling
    every tool call and halving the reported error rate.
  - Permission blocks are counted per entry in `resources[]`, `reply: "reject"` on
    `permission.replied` counts as a block, and a denied `bash`/`shell` permission action is counted
    as shell friction.
  - Model identity accepts the forwarded object (`{ providerID, modelID }`) as well as a string.
  - `ts`/`data.ts` added to the timestamp candidates; `data.location.directory` and `data.cwd`
    added to the workspace candidates; the plugin's own default audit directory
    (`<data home>/opencode-workflow/audit`) is now discovered automatically.
  - Unattributed records no longer fabricate a session, and the RSI guard counts only projects with
    at least one real session, so a one-shot CLI `plugin.loaded` record can never be "cross-project
    evidence" for pruning. Unattributed records are reported as a warning.
  - Dead-skill proposals require at least one observed skill activation in the window (no skill
    events are emitted by the plugin yet, so "unobserved" is reported instead of "dead").
- **`scripts/verify-setup.mjs`:** added `--live` (verify `~/.config/opencode` instead of an isolated
  copy), `--audit-dir`, `inspectAuditEvidence()` (requires a real `plugin.loaded` record and fails
  if the logger was disabled at runtime), `resolveAuditDir()` (same resolution as the plugin), and
  honest `mcp list` reporting. Fixed a real bug: `debug config`/`debug agents` stdout was parsed
  after truncation to 4,000 chars, so any real-size config failed the JSON check; raw stdout is now
  used for parsing and only the sanitized copy is reported.
- **New integration test** in `test/workflow-automation.test.mjs`: boots the real audit plugin
  against mocked hooks/events, writes real JSONL for two projects (6 sessions, tool successes and
  failures, permission denials with `resources[]`, a shell record, usage/compaction events), then
  feeds that exact directory into both `consolidateMemory()` and `runRsiPrune()` and asserts the
  parsed counts, costs, models, resources, shell prefixes, guard verdict, and absence of
  fabricated dead-skill proposals.
- **Live activation** (2026-11-22): `npm run sync` against `~/.config/opencode` deleted the exposed
  `service.json`, moved `tui.jsonc`, `herdr-tui-session.js`, `package.json`, `package-lock.json` and
  `plugins/herdr-agent-state.js` into `v1-disabled/`, backed up the previous `opencode.jsonc` as
  `opencode.jsonc.bak-2026-11-22T09-17-05-516Z`, and installed `opencode.jsonc` + `AGENTS.md`.
  `/root/.pi` was verified untouched (identical 407-file manifest before/after).

### Verified during Wave 3A (zero paid LLM calls)

- `npm test` — **60 tests / 60 pass / 0 fail / 0 skipped.**
- `npm run verify -- --schema` (repository config, isolated XDG) — **PASS** on every check: JSONC
  parse, Terra ban, `pi_search` (local + codemode), 8/8 agents, permission ordering, AGENTS.md
  2,261 <= 3,000 chars, binary checks (all exit 0), audit plugin evidence, live schema.
- `npm run verify -- --schema --live` (real `~/.config/opencode/`) — **PASS**, same checks.
- `opencode --standalone debug config` (live) resolves 3 config documents, keeps
  `model: {providerID: openrouter, model: google/gemini-4-neon, variant: high}`,
  `plugins: ["/root/pi-projects/opencode-workflow/plugins/audit-logger"]`, and
  `mcp.servers.pi_search` with `codemode: true`.
- `opencode --standalone debug agents` (live) lists the 8 configured agents plus the 5 built-ins
  (`compaction`, `explore`, `general`, `summary`, `title`) with the pinned models.
- Audit plugin loads cleanly: log lines `msg="loading plugin"
  id=/root/pi-projects/opencode-workflow/plugins/audit-logger` and **zero** `failed to load plugin`
  lines for it (the only such lines on disk are the retired v1 `herdr-agent-state.js` plugin from
  08:42–08:56, before activation).
- Real audit JSONL on disk: `~/.local/share/opencode-workflow/audit/2026-11-22.jsonl` (0600, dir
  0700) contains `plugin.loaded` records with `app.version: "2.3.2"`, `location.directory`,
  `auditDir`, `loggingEnabled: true`, and matching `plugin.stopped` records.
- `npm run prune -- --days 7` over that live audit directory parses it with 0 malformed lines and
  correctly REFUSES global pruning (0 projects with sessions, 0 sessions) and withholds dead-skill
  proposals because no skill activations were observed.
- MCP, honestly reported: `opencode --standalone mcp list` prints `No MCP servers configured`, while
  the log records `message="mcp connected" server=pi_search tools=4` on every location-materializing
  run. The server connects with 4 tools; the `mcp list` view is a 2.3.2 display gap. `npm run
  verify` reports this as WARN, not PASS.
- Rollback readiness (non-destructive): every file retired from `~/.config/opencode` is byte-identical
  (sha256) to `/root/.opencode-v1-backup-20261122/config` (`opencode.jsonc`, `plugins/herdr-agent-state.js`,
  `tui.jsonc`, `herdr-tui-session.js`, `package.json`, `package-lock.json`), and the backed-up v1
  binary runs and reports `1.18.32`. The restore itself was **not** executed.

### Remaining unverified after Wave 3A

- Live **paid** OpenRouter turn (interactive `opencode` prompt or `npm run supervise`) — model
  routing/agent hand-off/cost accounting not exercised end to end.
- Live **interactive MCP tool invocation** inside a session (only connect + tool count observed).
- Audit telemetry for real tool/permission/shell records on this machine (only `debug`-run
  `plugin.loaded` / `plugin.stopped` exist so far; the real-shape handling is proven by the mocked
  end-to-end test instead).
- `~/.config/opencode/node_modules` still holds the v1 `@opencode-ai/plugin@1.18.14` tree; it is
  inert for v2 but is not managed by `npm run sync`.
- `opencode mcp list` still reports no MCP servers (2.3.2 display gap).
- End-to-end rollback restore not executed (snapshot integrity verified instead); needs an approved
  maintenance window because it swaps the live config back and forth.
