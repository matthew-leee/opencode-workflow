# opencode-workflow

OpenCode v2 workflow for this machine: one lean global ruleset, a routed multi-vendor agent
roster, a schema-verified global config, a secret-redacting audit plugin, and a thin outer-loop
supervisor with bounded `MEMORY.md` and a weekly multi-project RSI pruning guard.

Pi remains installed and untouched. `pi-search` remains the Rust research engine, reached over MCP.

**Status: Waves 1, 2A, 2B, 2C, 3A, 4A, 4B, 6A, 6B, 7B and 8 complete. Live config re-synced 2026-11-22
09:59 UTC, so `~/.config/opencode/opencode.jsonc` is now byte-identical to `config/opencode.jsonc`
(sha256 `23fd8a42…`) and carries both Wave 6A's `.env.example` command-surface fix and the Wave 6B
hardening.**
`node --test test/audit-logger.test.mjs` is 26/26 PASS, `node --test test/workflow-automation.test.mjs`
is 78/78 PASS, `npm test` is **104/104 PASS**, and `npm run verify -- --schema --skip-binary`, `npm run
verify` (isolated) and `npm run verify -- --schema --live` (the real `~/.config/opencode/`) all end
**Verify PASS with exit 0**. Wave 8 closed the last three surgical edge cases from the independent
reviewer audit: session-less records no longer inflate model-routing or dead-skill evidence, an
in-target symlink at a sync destination (`opencode.jsonc -> victim.json`) is refused instead of being
followed, and `unwrapResolvedConfig()` merges only `type:"document"` entries. Wave 7B closed the last
open verifier defect: `validateResolvedConfig()`
now unwraps OpenCode 2.3.2's real `debug config` output — an array of `{type,path,info}` entries where
only `type:"document"` carries the config and `model` is the normalized object
`{providerID,model,variant}` — while still rejecting `{}`, `[]`, a document-less entry list, a model
outside the OCW-03 catalog, a missing `pi_search` server and a missing `audit-logger` plugin.
Remaining unverified items are listed at the end. See `Vision.md` for the requirements (`OCW-01`..`OCW-09`) and
`CHANGELOG.md` for the evidence trail.

## Layout

```
.
├── config/
│   ├── AGENTS.md          # lean global engineering rules (2,261 chars) — synced to ~/.config/opencode/AGENTS.md
│   └── opencode.jsonc     # global OpenCode v2 config — synced to ~/.config/opencode/opencode.jsonc
├── plugins/
│   └── audit-logger/      # append-only, secret-redacted JSONL audit plugin (@opencode/plugin 2.3.2)
│       ├── index.js       # hooks + event subscriber + bounded JSONL writer
│       ├── redact.js      # structural + textual secret redaction, size bounds
│       └── package.json   # name "opencode-workflow-audit", main index.js, no exports map
├── scripts/
│   ├── sync-global.mjs    # npm run sync   — install config into ~/.config/opencode, retire v1 files
│   └── verify-setup.mjs   # npm run verify — JSONC/permission invariants + live binary + audit evidence
├── src/
│   ├── supervisor.mjs     # npm run supervise   — @opencode/client outer loop (semantic progress)
│   ├── memory-consolidate.mjs # npm run consolidate — MEMORY.md <= 2,500 chars + shared audit readers
│   ├── rsi-prune.mjs      # npm run prune       — weekly RSI review with forgetting guard
│   └── openrouter-client.mjs # redacting OpenRouter HTTP client used by the three above
├── test/
│   ├── audit-logger.test.mjs      # 26 tests: redaction, hooks, events, writer safety, teardown
│   └── workflow-automation.test.mjs # 78 tests: supervisor, memory, RSI guard, client, sync, verify, JSONL integration
├── Vision.md              # authoritative destination and requirements
├── Decisions.md           # language, model lineup, outer-loop architecture, verified config shapes
├── README.md
└── CHANGELOG.md
```

## Requirements

- Node.js >= 22 (verified on v22.23.4)
- OpenCode v2.3.2 at `/root/.opencode/bin/opencode`
- `pi-search` MCP server at `/root/pi-projects/pi-search/bin/pi-search`
- An OpenRouter credential already configured in OpenCode (this repo never stores keys)

## Install

```bash
cd /root/pi-projects/opencode-workflow
npm install          # installs @opencode/plugin@2.3.2 and @opencode/client@2.3.2
```

## Scripts

| Script | Command | Purpose |
| --- | --- | --- |
| `npm test` | `node --test test/*.test.mjs` | Full offline suite (**104 tests**: 26 audit-logger + 78 workflow-automation). No network, no paid model calls, no writes outside temp dirs. |
| `npm run sync` | `node scripts/sync-global.mjs` | Install `config/opencode.jsonc` + `config/AGENTS.md` into `~/.config/opencode/`, rotate an exposed `service.json`, move legacy v1 files into `v1-disabled/`, back up anything it overwrites. Every write goes through an atomic temp file with a **cryptographically random name** opened `O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW`, so a planted `.tmp` symlink is never opened and a symlink at the destination is refused **on its lexical path** — including an in-target link such as `opencode.jsonc -> victim.json`, whose referent is never overwritten (the link is replaced by `rename`, never followed). `--dry-run` previews, `--skip-service-rotate` keeps the credential file, `--target-dir DIR` retargets. |
| `npm run verify` | `node scripts/verify-setup.mjs` | Parse JSONC strictly and assert the OCW-02/03/04 invariants: compaction/tool-output/media limits bounded, every agent (and the top-level default model) pinned to an id in the explicit **OCW-03 approved model catalog** rather than merely matching a `provider/model` shape, primary/subagent modes and bounded subagent steps, read-only roles denying `edit`/`write`/`patch`, `.env` protected on read/edit/write/patch/bash/shell while `.env.example` stays allowed for the file-path tools only (shell/bash `.env*` fails closed to `ask`, and the verifier resolves `cat .env # .env.example` / `cat .env; cat .env.example` to prove it), plus Terra ban, `pi_search` + codemode and permission ordering. Then run `opencode --standalone debug config` / `debug agents` / `mcp list` against an isolated `XDG_DATA_HOME`, require the OpenCode log and a fresh `plugin.loaded` record **stamped with `plugin: "opencode-workflow-audit"` and `loggingEnabled: true`** from that run (a missing log, a bare/foreign `plugin.loaded` line, or a runtime-disabled logger is a hard failure, never a warning), and report `mcp list` honestly. `--schema` adds the live schema check, `--live` verifies `~/.config/opencode/` instead of an isolated copy, `--skip-binary` stays offline, `--json` prints machine output. The `debug config` gate is shape-tolerant since Wave 7B: it accepts a plain config object **or** 2.3.2's array of `{type,path,info}` entries (merging `info` from `type:"document"` entries only — a `directory` or other non-document entry is never merged even when it carries a non-empty `info` — with later documents winning per top-level key), and a `model` given as a string id **or** as the normalized `{providerID,model,variant}` object — both then held to the OCW-03 catalog — while still rejecting `{}`, `[]`, a directory-only entry list, and a config that resolves no model, no local `pi_search` (codemode not explicitly disabled) or no `audit-logger` plugin. |
| `npm run prune` | `node src/rsi-prune.mjs` | Weekly RSI review over the audit JSONL: tool/model error rates, permission blocks, shell friction, AGENTS.md size, Terra scan, dead skills. Read-only; **each proposal is gated on its own** distinct-project/session evidence (2 projects + 5 sessions), refused proposals are listed under `pruning.withheld` with their per-proposal `evidence`, and `--force` overrides while recording `forced` on the proposal. Per-proposal evidence only counts a project when the *same* record also carries an attributed session — the same rule applies to the permission/shell, model-routing and dead-skill evidence sets — so a session-less `plugin.loaded`/`shell.before`/usage/skill record from a second tree can never supply the second project that unlocks a global change. `--out FILE` is canonicalized through a segment-by-segment `realpathDeep` (which resolves dangling symlinks instead of falling back to the link's own path) and refused inside `/root/.pi`, `pi-workflow-tools`, the live OpenCode config or `config/`, and the write itself uses `O_NOFOLLOW`, so a planted symlink cannot redirect the report. `--days N`, `--audit-dir DIR`, `--json`, `--with-llm`. |
| `npm run consolidate` | `node src/memory-consolidate.mjs` | Rebuild a project's `MEMORY.md` from recent audit telemetry, hard-capped at 2,500 characters (one compression retry, then section-preserving truncation). Workspace attribution compares canonical **full paths**, so two absolute workspaces that share a basename never pool their telemetry, and an absolute-vs-relative (or bare-label) mismatch fails closed instead of matching on basename; an existing 0-byte `MEMORY.md` is still backed up to `MEMORY.md.bak` before being replaced. Needs `OPENROUTER_API_KEY` in the environment or a passed model. `--workspace DIR`, `--audit-dir DIR`, `--dry-run`, `--max-chars N`. |
| `npm run supervise` | `node src/supervisor.mjs` | Drive OpenCode sessions milestone-by-milestone from `PLAN.md`, judge *semantic* progress, steer/escalate/stop with a stated reason, mark milestones, consolidate `MEMORY.md`. Spend is metered per accounting epoch (a `fresh_session` or escalation starts a new one and folds the finished epoch into the cumulative total), each finished epoch is checked against `--max-usd` (default 15) and the whole run against `--max-total-usd` (default 30), and non-positive/non-finite limits are rejected instead of disabling the fuse. `--workspace DIR`, `--spawn-server` or `--base-url URL`, `--model ID`, `--memory-model ID`, `--max-usd N`, `--max-total-usd N`, `--tool-checkpoint N`, `--dry-run`. |

Interactive OpenCode itself is unchanged: run `opencode` (or `/root/.opencode/bin/opencode`) after
`npm run sync`; it reads the synced `~/.config/opencode/opencode.jsonc` and `AGENTS.md`.

## Live activation (performed 2026-11-22)

`npm run sync` against `~/.config/opencode` performed exactly this:

```
  rotate service credentials: /root/.config/opencode/service.json
  move legacy /root/.config/opencode/tui.jsonc -> /root/.config/opencode/v1-disabled/tui.jsonc
  move legacy /root/.config/opencode/herdr-tui-session.js -> /root/.config/opencode/v1-disabled/herdr-tui-session.js
  move legacy /root/.config/opencode/package.json -> /root/.config/opencode/v1-disabled/package.json
  move legacy /root/.config/opencode/package-lock.json -> /root/.config/opencode/v1-disabled/package-lock.json
  move legacy /root/.config/opencode/plugins/herdr-agent-state.js -> /root/.config/opencode/v1-disabled/plugins/herdr-agent-state.js
  backup /root/.config/opencode/opencode.jsonc -> /root/.config/opencode/opencode.jsonc.bak-2026-11-22T09-17-05-516Z
  copy config/opencode.jsonc -> /root/.config/opencode/opencode.jsonc
  copy config/AGENTS.md -> /root/.config/opencode/AGENTS.md
```

Notes on the result:

- `service.json` was **deleted**, which is the rotation: the previously exposed credential is dead
  and a fresh one is generated the next time an OpenCode service starts.
- Nothing was deleted except that credential file. Legacy v1 files were *moved*, never removed.
- `~/.config/opencode/node_modules` (v1 `@opencode-ai/plugin@1.18.14`) is left in place; sync does
  not manage it. It is inert for v2: the audit plugin imports `@opencode/plugin@2.3.2` from this
  repository's `node_modules`, and OpenCode logged a clean plugin load (see below).
- An OpenCode v1 process that was already running keeps its in-memory config until restarted; new
  CLI invocations read the v2 config.

### Re-sync (performed 2026-11-22 09:59 UTC, Waves 6A + 6B)

`npm run sync` against `~/.config/opencode` performed exactly this:

```
Synced to /root/.config/opencode
  backup /root/.config/opencode/opencode.jsonc -> /root/.config/opencode/opencode.jsonc.bak-2026-11-22T09-59-40-970Z
  copy /root/pi-projects/opencode-workflow/config/opencode.jsonc -> /root/.config/opencode/opencode.jsonc
  skip service-rotate /root/.config/opencode/service.json: not present
  skip copy /root/.config/opencode/AGENTS.md: already identical
```

- `~/.config/opencode/opencode.jsonc` and `config/opencode.jsonc` are now byte-identical
  (sha256 `23fd8a424957e9b409b10bdc30e57160bb97e3529865d185c7c028ef130625d6`); `AGENTS.md` was already
  identical (sha256 `efc26e3b…`) and was not rewritten.
- The previous live config is preserved at
  `~/.config/opencode/opencode.jsonc.bak-2026-11-22T09-59-40-970Z`; that is the rollback point for
  this re-sync. No file was deleted, and no `service.json` was present to rotate.
- This is what makes Wave 6A's `.env.example` command-surface fix **live**: the two
  `{ "action": "bash"|"shell", "resource": "*.env.example", "effect": "allow" }` rules are gone
  from the installed config.
- Verified after the copy: `sha256sum` equality, and `npm run verify -- --schema --live`. At re-sync
  time it failed on the then-unfixed Wave 6B `validateResolvedConfig` shape assumption (a verifier
  defect, not a config defect); after Wave 7B's verifier fix the same command ends **Verify PASS,
  exit 0** with 14 PASS lines and 0 FAIL.

### Rollback

```bash
# 1. restore the v1 config tree (full snapshot taken before activation)
rm -rf ~/.config/opencode
cp -a /root/.opencode-v1-backup-20261122/config ~/.config/opencode

# 2. restore the v1 binary only if the v2 binary must be reverted too
cp -a /root/.opencode-v1-backup-20261122/bin/opencode /root/.opencode/bin/opencode
```

The v1 snapshot does **not** contain `service.json` (it was created after the snapshot), so a
restored v1 starts with a fresh service credential — the exposed one stays invalid. The moved v1
files are also recoverable individually from `~/.config/opencode/v1-disabled/`, and the previous
`opencode.jsonc` from `~/.config/opencode/opencode.jsonc.bak-2026-11-22T09-17-05-516Z`.

Rollback readiness was checked non-destructively on 2026-11-22: every retired file is byte-identical
(sha256) to its copy in `/root/.opencode-v1-backup-20261122/config` — `opencode.jsonc`
(`4e901f9e…`), `plugins/herdr-agent-state.js` (`5cb15e05…`), `tui.jsonc` (`6443aefa…`),
`herdr-tui-session.js` (`dc79b96c…`), `package.json` (`2b1209f2…`), `package-lock.json`
(`05e78a28…`) — and `/root/.opencode-v1-backup-20261122/bin/opencode --version` reports `1.18.32`.
The end-to-end restore itself has not been executed (it would swap the live config back and forth).

## Verification results (2026-11-22, zero paid LLM calls)

Latest run after Wave 8 (2026-11-22, zero paid LLM calls): `npm test` — **104 tests, 104 pass, 0
fail, 0 skipped** (26 audit-logger + 78 workflow-automation); `npm run verify -- --schema
--skip-binary` — **PASS, exit 0**; `npm run verify` (isolated copy + real binary) — **PASS, exit 0**;
`npm run verify -- --schema --live` against the real `~/.config/opencode/` — **Verify PASS, exit 0**,
14 PASS lines, 0 FAIL, one honest WARN (`mcp list did not show pi_search`, the known 2.3.2 display
gap). The Wave 4A/4B/6A/6B/7B numbers below are the historical records of those waves.

- `npm test` (Wave 4A/4B tree) — **87 tests, 87 pass, 0 fail, 0 skipped** (26 audit-logger + 61 workflow-automation).
- `npm run verify -- --schema` (repository config, isolated `XDG_CONFIG_HOME`) — **PASS**:
  JSONC parse, Terra ban, `pi_search` MCP (local + codemode), agent roster 8/8, pinned models 8/8,
  agent modes + subagent steps <= 100, read-only agents denying `edit`/`write`/`patch`, bounded
  compaction/tool-output/media limits, `.env` protection on read/edit/write/patch/shell/bash,
  permission ordering, AGENTS.md 2,261 <= 3,000 chars, OpenCode binary checks (exit 0), fresh
  `plugin.loaded` evidence, live schema check.
- `npm run verify -- --schema --live` (the real `~/.config/opencode/`) — **PASS** on all 14 checks and
  the live schema fetch, with one honest WARN: `mcp list did not show pi_search (known 2.3.2
  materialization gap; config itself is validated above)`.
- `opencode --standalone debug config` against the live config resolves three config documents and
  normalizes `model` to `{providerID: "openrouter", model: "google/gemini-4-neon", variant: "high"}`,
  keeps `plugins: ["/root/pi-projects/opencode-workflow/plugins/audit-logger"]`, and keeps
  `mcp.servers.pi_search` with `codemode: true`.
- `opencode --standalone debug agents` returns 13 agents: the 8 configured (`build`, `plan`,
  `worker`, `reviewer`, `fact-checker`, `escalate-opus`, `escalate-fable`, `alt-reviewer`) plus the
  5 built-ins (`compaction`, `explore`, `general`, `summary`, `title`), each with the pinned model.
- Audit plugin: `~/.local/share/opencode-workflow/audit/2026-11-22.jsonl` (mode 0600, directory
  0700) contains real `plugin.loaded` records with `app.version: "2.3.2"`, the working directory,
  `auditDir`, and `loggingEnabled: true`, plus matching `plugin.stopped` records.
- OpenCode log `~/.local/share/opencode/log/opencode.log` shows `msg="loading plugin"
  id=/root/pi-projects/opencode-workflow/plugins/audit-logger` and **zero** `failed to load plugin`
  lines for it. The only such lines on disk are the retired v1 `herdr-agent-state.js` plugin from
  08:42–08:56, before activation.
- MCP, honestly: `opencode --standalone mcp list` prints `No MCP servers configured`, **while** the
  same log shows `message="mcp connected" server=pi_search tools=4` on every run that materializes a
  location (`debug agents`, for `directory=/root/pi-projects/opencode-workflow` and `/root`). So the
  server connects and exposes 4 tools; the `mcp list` CLI view is the known 2.3.2 display gap
  (it does not report location-materialized servers). `npm run verify` reports this as a WARN, not
  a PASS.
- `~/.pi` was verified untouched: a `find /root/.pi -type f -printf '%p %s %T@'` manifest of all
  407 files is byte-identical before and after activation.

### Wave 4A security/correctness hardening (2026-11-22, zero paid LLM calls)

Reviewer Part A found five blocking defects; all five are fixed and each has a regression test in
`test/audit-logger.test.mjs`.

- **`.env` bypass closed (OCW-02).** After the baseline `allow *`, `read`/`edit`/`write`/`patch`
  ask on `*.env` and `*.env.*`, and `bash`/`shell` ask on command-shaped globs (`*.env*`,
  `* .env*`, `*/*.env*`, `*.env *`, `*.env`). `*.env.example` is re-allowed afterwards on the four
  file-path surfaces only; Wave 6A removed the two command-surface re-allows described below.
  `npm run verify -- --schema` PASS, including the live schema fetch.
- **Bare credential assignments redacted.** `PASSWORD=hunter2`, `TOKEN=secretvalue`,
  `API_KEY=secretvalue`, `OPENAI_KEY=supersecretvalue` and textual `{"apiKey":"supersecretvalue"}`
  all become `[REDACTED]`; `MAX_TOKENS=4096` still survives.
- **Redaction before truncation.** Strings are now redacted first and capped afterwards, and an
  unclosed `-----BEGIN … PRIVATE KEY-----` block replaces the whole tail with
  `[REDACTED_PRIVATE_KEY]`, so a 4,000-character boundary cannot leak `SECRETKEYMATERIAL`.
- **`Error.name` handled like `Error.message`.** Both the deep walk (`redact.js`) and the structured
  error summary (`index.js`) redact and cap the name. Revoked Proxy objects no longer throw out of
  `redact()`.
- **Audit writer fails closed.** The directory must verify as 0700 and the daily file as 0600 after
  `chmod`/`fchmod`; otherwise logging disables itself. The file is opened with `O_NOFOLLOW` +
  `O_NONBLOCK` and checked with `fstat` before writing, so symlinks, FIFOs and other non-regular
  files are refused and their targets stay untouched.
- **Teardown is bounded.** Each `registration.dispose()` is raced against a 1,500 ms timeout; a hung
  hook is recorded as `cleanup.dispose.timeout` and the remaining hooks are still disposed.
- **Verified:** `node --test test/audit-logger.test.mjs` **26/26 PASS**; `npm test` **87/87 PASS**.

### Wave 4B hardening (2026-11-22, zero paid LLM calls)

Reviewer Part B found correctness and cost-control defects in the automation scripts; every fix
below has a regression test in `test/workflow-automation.test.mjs` (42 → 61 tests).

- **Supervisor spend fuses (OCW-07).** `--max-total-usd` (default `$30`, twice `--max-usd`) is now a
  real cumulative fuse. Spend is metered per *accounting epoch*: a `fresh_session` or an agent
  escalation finalizes the finished epoch into `finalizedSpentUsd` and starts a new one from the
  provider's cumulative session cost, so a fresh session cannot reset the total. Both the per-session
  and cumulative fuses are checked on every usage update and again before a semantic decision.
- **Strict numeric options.** `strictPositiveNumber` / `strictPositiveInteger` reject `NaN`,
  `Infinity`, zero, negatives and non-integer step limits with `InvalidSupervisorOptionError` instead
  of silently disabling a fuse (an unset/empty value still takes the default).
- **`--memory-model`.** Consolidation can use a cheaper/different model than the supervisor; it
  defaults to the supervisor model and then `deepseek/deepseek-v4.1-flash-1017`.
- **Usable telemetry.** `toolLabel()` prefers the native tool name (`data.native.name`, e.g.
  `apply_patch`) over generic names/ids, and terminal execution events
  (`session.execution.succeeded`/`failed`/`interrupted`) are semantic checkpoints in their own right,
  so a decision is possible even when no tool-call or idle checkpoint arrives. `failed` counts as an
  error signal; `interrupted` is terminal but not an error.
- **OpenRouter `Error.cause` sanitized.** `sanitizeErrorCause()` rebuilds a `cause` with only the
  redacted message/name/code and drops `request`/`config`/further cause links, so a raw `fetch`
  failure can never leak the API key through `error.cause`, its stack, or `JSON.stringify`.
- **Memory attribution by full path.** Workspace matching compares canonical absolute paths
  (exact or child containment), so `/work/alice/shared` and `/work/bob/shared` are different
  projects; the basename fallback survives only for relative paths. A record's bare project label is
  never treated as evidence for an absolute workspace. An existing **empty** `MEMORY.md` is backed up
  to `.bak` on existence, not on content truthiness.
- **Per-proposal RSI guard.** Each pruning proposal carries its own `evidence`
  (`distinctProjects`, `sessions`, `forced`) and is gated independently; refused proposals appear in
  `pruning.withheld` with `withheldReason`, so one weak single-project pattern can no longer ride a
  global "2 projects / 5 sessions" verdict. `--force` still overrides but records `forced: true` and
  a warning.
- **Canonical `--out` protection.** `rsi-prune.mjs --out` resolves through `realpathSync` (including
  not-yet-existing segments) and refuses the filesystem root, `/root/.pi`,
  `/root/pi-projects/pi-workflow-tools`, `~/.config/opencode` and this repo's `config/`, so a symlink
  cannot smuggle a report into a protected tree.
- **`sync-global.mjs` canonical protections.** The target and both forbidden trees are compared by
  literal path **and** `realpathSync`, and every write/move/delete inside the target is
  re-canonicalized, so a `v1-disabled` symlink pointing at `/root/.pi` is refused.
- **Stricter verify.** `npm run verify` now hard-fails when a binary run produced no OpenCode log or
  no `plugin.loaded` record from its own isolated run directory (historical evidence is never
  accepted), and enforces OCW-02/03/04: bounded compaction/tool-output/media limits, pinned
  catalog-resolvable agent models, primary/subagent mode + bounded steps, read-only write denials,
  and `.env` protection on read/edit/write/patch/bash/shell with `.env.example` allowed for the
  file-path tools.
- **Verified:** `npm test` **87/87 PASS**; `npm run verify -- --schema --live` **PASS** against the
  re-synced live config; `npm run sync` re-installed the hardened `opencode.jsonc` (backup
  `opencode.jsonc.bak-2026-11-22T09-47-04-566Z`).

### Wave 6A `.env.example` shell/bash bypass fix (zero paid LLM calls; live since 2026-11-22 09:59 UTC)

Reviewer Part A's last blocker: the `*.env.example` `allow` rules were also declared for the `bash`
and `shell` actions, whose resource is the **whole command string**, not a path. A command that merely
ends in `.env.example` therefore matched — `cat .env # .env.example` and `cat .env; cat .env.example`
both resolved to `allow` while reading the real `.env`.

- **Command-surface re-allow removed.** `config/opencode.jsonc` keeps `*.env.example` `allow` for
  `read`/`edit`/`write`/`patch` (single-path resources) and declares **none** for `bash`/`shell`, with
  a comment recording why. Any command mentioning `.env*` now falls through to the `ask`
  command-glob rules (`*.env*`, `* .env*`, `*/*.env*`, `*.env *`, `*.env`) instead.
- **No test or verifier change needed.** `npm run verify` requires `.env.example` to be allowed for
  the `read` action and `.env` to ask on all six actions; both still hold, so the fix tightens the
  ruleset without loosening a checked invariant.
- **Verified:** `npm test` **87/87 PASS** (unchanged) and `npm run verify -- --schema --skip-binary`
  **PASS** including the live schema fetch, with `.env protection: pass (read, edit, write, patch,
  shell, bash)` and `.env.example` still allowed for `read`. Zero paid LLM calls.
- **Now live.** The fix was repository-only when Wave 6A landed; `npm run sync` on 2026-11-22 09:59
  UTC installed the corrected config (`opencode.jsonc.bak-2026-11-22T09-59-40-970Z` is the previous
  live copy), so the two `bash`/`shell` `*.env.example` allow rules are gone from
  `~/.config/opencode/opencode.jsonc`.

### Wave 6B hardening (2026-11-22, zero paid LLM calls)

Reviewer follow-ups on the Wave 4B/6A fixes, each with a regression test in
`test/workflow-automation.test.mjs` (61 → **72** tests). The hardened config was then re-synced live.

- **Derived total-fuse overflow rejected (OCW-07).** `strictPositiveNumber()` now validates the
  *fallback* too, not just the caller's value. A derived default such as
  `maxUsdPerSession * DEFAULT_MAX_USD_TOTAL_MULTIPLIER` becomes `Infinity` once `maxUsdPerSession`
  approaches `Number.MAX_VALUE`, which would silently disable the cumulative spend fuse; the
  supervisor now refuses to start with `InvalidSupervisorOptionError` instead.
- **Absolute/relative workspace attribution fails closed.** `pathMatchesWorkspace()` no longer matches
  on basename across an absolute/relative mismatch. A bare label such as `shared` carries no absolute
  identity (`/work/alice/shared` or `/work/bob/shared`?), so `shared` vs `/work/alice/shared` never
  matches in either direction; basename equality is used only when *both* sides are relative.
- **Session-required per-proposal RSI evidence.** `recordEvidence()` counts a project only when the
  same record also carries an attributed session. A session-less `plugin.loaded`/`shell.before` from
  a second tree can no longer supply the second project that unlocks a global pruning proposal.
- **Dangling-symlink-safe path resolution.** `realpathDeep()` (in both `src/rsi-prune.mjs` and
  `scripts/sync-global.mjs`) walks segment by segment with `lstat`/`readlink`, so a **dangling** link
  into a protected tree resolves to its real (not-yet-existing) destination instead of falling back
  to the link's own path. Symlink loops are bounded at 40 hops. The RSI report write additionally
  uses `O_NOFOLLOW`, closing the check-then-open race.
- **Random `O_EXCL|O_NOFOLLOW` atomic temp writes in `sync-global`.** `atomicWrite()` now uses a
  cryptographically random temp name (`.<basename>.<32 hex>.tmp`) opened
  `O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW`, plus a destination `lstat` before and after the write and a
  `rename` that replaces a link rather than following it. A planted `opencode.jsonc.tmp` symlink is
  never opened, and a symlink at the destination is refused.
- **`verify-setup` tightened (OCW-03/06).** Model pinning is no longer a shape-only regex: an explicit
  `APPROVED_MODELS` catalog is enforced for the eight roster agents, every other configured agent and
  the top-level `model` (`not-a-catalog/model` is rejected, `openrouter/google/gemini-4-neon#high` is
  accepted). The verifier now resolves `cat .env # .env.example` and `cat .env; cat .env.example` on
  both `shell` and `bash` and requires ask/deny, and it requires the four file-path tools to allow
  `.env.example`. Audit evidence must be **authentic**: `plugin: "opencode-workflow-audit"` *and*
  `loggingEnabled: true` in a fresh record from the run's own isolated audit directory; a bare or
  foreign `plugin.loaded` line, or a runtime-disabled logger, is a hard failure.
- **Verified at the time:** `npm test` — **98/98 PASS** (26 audit-logger + 72 workflow-automation);
  `npm run verify -- --schema --skip-binary` — **PASS**; `npm run sync` — clean, live config now
  byte-identical to `config/`; `npm run verify -- --schema --live` — **FAIL on one check** (the shape
  defect below, closed by Wave 7B).
- **Open defect found by the new gate (fixed in Wave 7B).** `validateResolvedConfig()` assumed
  `opencode --standalone debug config` prints a single config object with a string `model`. The real
  2.3.2 output is an array of three entries — `{type:"document",path,info:{…}}` plus two
  `{type:"directory"}` entries — and `model` inside `info` is the normalized object
  `{providerID:"openrouter",model:"google/gemini-4-neon",variant:"high"}`. The binary exits 0 and the
  config really did resolve a model, `mcp.servers.pi_search` and the audit plugin, so the failure was
  in the verifier's shape assumption. Wave 7B fixes it (see the Wave 7B section below).

### Wave 7B — `debug config` shape fix (2026-11-22, zero paid LLM calls)

Closes the one open verifier defect from Wave 6B. No config file changed; only the verifier, its
tests and documentation.

- **`validateResolvedConfig()` accepts the real 2.3.2 shape.** `unwrapResolvedConfig()` returns a
  plain config object unchanged, or merges the `info` objects of `type:"document"` entries from the
  array output in output order, so a later document wins per top-level key while keys only the
  earlier document defines survive. `directory` entries carry an empty `info` and contribute nothing.
- **Rejections keep their strength.** `{}`, `[]`, a directory-only entry list, `null`, a config with
  no model, no `mcp.servers.pi_search` (it must be `type: "local"` with `codemode` not explicitly
  `false`) and no `audit-logger` plugin all still fail, each with its own message.
- **`model` accepts both spellings, one catalog.** `resolvedModelId()` normalizes the string form
  (`openrouter/google/gemini-4-neon#high`) and the resolved object form
  (`{providerID:"openrouter",model:"google/gemini-4-neon",variant:"high"}`) to the same
  `provider/model#variant` id, and both are then held to the OCW-03 `APPROVED_MODELS` catalog, so an
  unapproved normalized object (`{providerID:"openrouter",model:"not-a-catalog/model"}`) is rejected
  exactly like an unapproved string.
- **Regression tests (72 → 75 in `test/workflow-automation.test.mjs`).** The exact live 2.3.2
  array-of-documents fixture with the normalized model object is accepted (including document merge
  precedence and directory entries being ignored); `[]`, `[{type:"directory",info:{}}]`, `{}`,
  `null`, a missing model / `pi_search` / `audit-logger`, a non-local `pi_search`, `codemode: false`
  and an unapproved normalized model object are all rejected; and a stub binary that prints the real
  array shape is accepted end-to-end by `runBinaryChecks()` while a directory-only stub is rejected.
- **Verified:** `npm test` — **101 tests, 101 pass, 0 fail, 0 skipped** (26 audit-logger + 75
  workflow-automation); `npm run verify` (isolated) — **PASS, exit 0**; `npm run verify -- --schema
  --skip-binary` — **PASS, exit 0**; `npm run verify -- --schema --live` — **Verify PASS, exit 0**,
  14 PASS lines, 0 FAIL, 1 WARN (`mcp list did not show pi_search`, the known 2.3.2 display gap).

### Wave 8 — final reviewer edge cases (2026-11-22, zero paid LLM calls)

Three surgical fixes from the independent reviewer's final audit. No config file changed; only the
three modules, their regression tests and documentation.

- **Session attribution is now uniform across every evidence set.** The model-routing and dead-skill
  evidence sets in `src/rsi-prune.mjs` now count a project only when the *same* record also carries an
  attributed session, matching `recordEvidence()`. Previously a session-less `session.usage.updated`
  or `session.skill.activated` record from a second project could supply the second project that
  unlocked a model-routing or dead-skill proposal even though it contributed no history.
- **An in-target symlink at a sync destination is refused, not followed.** `scripts/sync-global.mjs`
  now `lstat`s the original lexical destination before resolving it and refuses the destination
  itself when it is a symlink, so `opencode.jsonc -> victim.json` can never overwrite `victim.json`.
  Out-of-target links keep the historical "symlink outside the sync target" error; the destination
  path is never replaced by the link's referent.
- **Only `type:"document"` entries are merged as resolved config.** `unwrapResolvedConfig()` in
  `scripts/verify-setup.mjs` no longer falls back to merging non-document entries that carry a
  non-empty `info`, so a fully-populated `{type:"directory"}` blob cannot pose as resolved config and
  pass `validateResolvedConfig()`.
- **Regression tests (101 → 104 total, 75 → 78 workflow-automation).** "session-less records cannot
  add a project to model-routing or dead-skill evidence" (5 attributed alpha records + 1 session-less
  beta record, global guard satisfied by alpha + gamma, both proposals withheld), "refuses an
  in-target symlink at the sync destination without following it" (link refused, `victim.json`
  untouched, no backup taken, dry run refused too), and "a non-document entry carrying info is never
  merged as resolved config" (directory-only blob rejected; a document in the same array still
  resolves and the directory's info is ignored).
- **Verified:** `npm test` — **104 tests, 104 pass, 0 fail, 0 skipped** (26 audit-logger + 78
  workflow-automation); `npm run verify -- --schema --live` — **Verify PASS, exit 0**, 14 PASS lines,
  0 FAIL, 1 WARN (`mcp list did not show pi_search`, the known 2.3.2 display gap). Each new regression
  test was also run against the pre-fix code and failed for the intended reason (2 projects instead of
  1; missing refusal; directory blob accepted).

## What the analyzers read from the audit JSONL

`plugins/audit-logger` writes one append-only record per interesting action to
`$OPENCODE_WORKFLOW_AUDIT_DIR` (default `~/.local/share/opencode-workflow/audit/<UTC day>.jsonl`).
Every record is `{ ts, v: 1, event, ...fields }`. `src/memory-consolidate.mjs` and
`src/rsi-prune.mjs` parse those real shapes directly (see the integration test):

| Record | Fields used |
| --- | --- |
| `plugin.loaded` / `plugin.stopped` | `ts`, `location.directory` (project attribution), `loggingEnabled`, `auditDir`, `app.version` |
| `session.prompt` | `sessionID`, `prompt.chars/preview`, `files`, `agents`, `skills` |
| `tool.before` / `tool.after` | `tool`, `callId`, `sessionID`, `status`, `durationMs`, `input.filePath`, `input.command`, `error.message` |
| `permission.evaluate` | `sessionID`, `action`, `resources[]`, `effect` (`deny`/`blocked`/`reject` count as blocks, per resource) |
| `permission.asked` / `permission.replied` | `sessionID`, `resources[]`, `reply` (`reject` counts as a block) |
| `shell.before` | `command`, `cwd`, `timeout`, `shell`, `envVarCount` (env values are never recorded) |
| `session.usage.updated` | `sessionID`, `cost`, `tokens` |
| `session.compaction.*` | `model` (object or id), `cost`, `tokens`, `reason` |
| `session.execution.failed` / `interrupted` | `sessionID`, `error.message`, `reason` |

Attribution and counting rules the readers apply, because the plugin's records are deliberately
sparse:

- **Session → project inference.** `tool.*` and `shell.before` records carry no
  `location.directory`, so the readers first build a session → workspace/project table from the
  records that do carry it (`plugin.loaded`, `session.*`, `permission.*`), then attribute tool and
  shell records through their `sessionID`. Without this, a workspace-scoped read would drop every
  tool call.
- **One call, one count.** A real call produces `tool.before` *and* `tool.after` with the same
  `callId`; the terminal record wins, so an error rate is not silently halved.
- **Permission blocks are per resource.** A denied `permission.evaluate` with three `resources[]`
  entries counts three blocked resources; a denied `bash`/`shell` action is also counted as shell
  friction with the blocked command as its prefix.
- **Unattributed is not a project and not a session.** Records with no session id are bucketed, and
  the RSI guard counts only projects that have at least one real session — so a one-shot CLI run is
  never "cross-project evidence" for pruning.
- **Unobserved is not unused.** No skill-activation records in the window means no dead-skill
  proposal; the report says so instead of marking every skill dead.
- **Model identity** accepts a string (`"openrouter/..."`) or the forwarded object
  (`{ providerID, modelID }`) and normalizes to `provider/model`.

## What the config does

- **Driver:** `openrouter/google/gemini-4-neon#high` with `default_agent: build`.
- **Context hygiene:** auto background compaction (20 % buffer, keep 15k tokens), tool output capped
  at 2,000 lines / 50 KiB, images auto-resized to 2000×2000 and 5 MiB base64.
- **Permissions:** everyday read/test/build/inspect is silent; destructive local actions, remote or
  publishing actions, infrastructure and database commands, and `.env`/`.env.*` across
  read/edit/write/patch plus `bash`/`shell` command globs ask first; `*.env.example` is explicitly
  re-allowed afterwards for the file-path actions only (`read`/`edit`/`write`/`patch`). Because a
  `bash`/`shell` resource is an entire command line, no `*.env.example` allow is declared there —
  otherwise `cat .env # .env.example` or `cat .env; cat .env.example` would slip past the `.env` ask;
  any command mentioning `.env*` therefore stays `ask`. Key reads (`*id_rsa*`, `*.pem`,
  `*/secrets/*`) ask.
- **Agents:** `build`, `plan` (primary), `worker`, `reviewer`, `fact-checker`, `escalate-opus`,
  `escalate-fable`, `alt-reviewer` (subagents). Read-only roles deny `edit`/`write`/`patch` and
  cannot spawn subagents. GPT-6.1 Terra appears nowhere.
- **Research:** `pi_search` MCP server with `codemode: true`.
- **Audit:** `plugins` loads `plugins/audit-logger` (this repository), which must never break the
  agent loop: every hook and write is wrapped, and a logging failure disables logging only. The
  writer fails closed when 0700/0600 cannot be verified or the daily path is a symlink/non-regular
  file, and teardown bounds each hook's `dispose()` at 1,500 ms.
- **Supervisor model (OCW-03/07):** approved System-1 supervisor options are
  `openrouter/deepseek/deepseek-v4.1-flash-1017` (default) and `openrouter/openai/gpt-6-luna`.
  `src/supervisor.mjs` defaults to `deepseek/deepseek-v4.1-flash-1017` and accepts `--model` for the
  approved alternative; `--memory-model` selects the consolidation model and defaults to the
  supervisor model, then to `deepseek/deepseek-v4.1-flash-1017`. Both numeric fuses validate the
  **derived** fallback as well as the supplied value, so an overflowing default
  (`maxUsdPerSession * 2 → Infinity`) refuses to start instead of silently disabling the fuse.

## Documentation

- `Vision.md` — destination, `OCW-*` requirements, non-goals, definition of done.
- `Decisions.md` — why TypeScript/ESM, the verified model lineup, the supervisor design, and every
  config shape confirmed against the 2.3.2 binary.
- `CHANGELOG.md` — what exists, what was verified, and the open gaps.

## Safety notes

- No secrets are stored or expected in this repository; `.env*` files are gitignored. The audit log
  redacts credentials structurally (credential-named keys, `env` maps) and textually (`Bearer`,
  `sk-*`, JWTs, PEM blocks including an unclosed/tail-truncated block, `KEY=value`, quoted JSON
  `"key":"value"` pairs, URL userinfo) **before** truncation, so nothing reaches disk. `Error.name`
  is redacted too.
- The audit directory/file are verified as 0700/0600 and written through an `O_NOFOLLOW`,
  `fstat`-checked regular-file descriptor; otherwise the logger disables itself rather than write
  to an unsafe path.
- Tests never call paid model providers or live external APIs. `npm run verify -- --schema` fetches
  the public JSON schema only.
- Nothing here modifies `/root/.pi` or `/root/pi-projects/pi-workflow-tools`. `sync-global.mjs`
  canonicalizes the target through a segment-by-segment `realpathDeep` and refuses both trees in any
  spelling, including a symlink that resolves into either one **and including a dangling symlink
  whose target does not exist yet**; every write/move is re-canonicalized so a planted `v1-disabled`
  symlink cannot escape the sync target. Config writes go through a randomly named temp file opened
  `O_CREAT|O_EXCL|O_NOFOLLOW` and are installed with `rename`, so a predictable `.tmp` symlink is
  never opened and a symlink at the destination is refused. `rsi-prune.mjs --out` applies the same
  canonical protection (plus the live OpenCode config and `config/`) and opens the report with
  `O_NOFOLLOW`.
- `openrouter-client.mjs` never forwards a caller's `Error.cause`: it rebuilds the cause with only
  the redacted message/name/code, so an upstream `fetch` error's `request`/`config` objects (and any
  `Authorization` header they hold) are unreachable from the error chain.

## Remaining unverified

- ~~`npm run verify -- --schema --live` fails on one verifier shape defect.~~ **Closed by Wave 7B.**
  `validateResolvedConfig()` now unwraps the 2.3.2 array-of-documents output and accepts the
  normalized `model` object, so the live run ends **Verify PASS, exit 0** (14 PASS, 0 FAIL, 1 known
  WARN). The fix is covered by three new regression tests (98 → 101 tests total).
- Live re-sync **has** been performed (2026-11-22 09:59 UTC): `~/.config/opencode/opencode.jsonc` is
  byte-identical to `config/opencode.jsonc` (sha256 `23fd8a42…`) and `AGENTS.md` was already identical,
  so the Wave 6A rule fix and the Wave 4A/4B/6B hardening are all live. The previous live config is at
  `opencode.jsonc.bak-2026-11-22T09-59-40-970Z`; no `service.json` was present.
- The earlier re-sync point is preserved too:
  `opencode.jsonc.bak-2026-11-22T09-47-04-566Z` (Wave 4A/4B only).
- OCW-09's "`npm run verify` passes" is now met end-to-end in all three modes (isolated binary run,
  `--schema --skip-binary`, and `--schema --live` against the real `~/.config/opencode/`); the only
  remaining live WARN is the 2.3.2 `mcp list` display gap below.
- A live **paid** OpenRouter turn (interactive `opencode` prompt or `npm run supervise`) has not been
  run in this session, so model routing, agent hand-off, and cost accounting are verified only at
  config/catalog level.
- A live **interactive MCP tool invocation** (`pi_search` tool call inside a session) has not been
  performed; only `mcp connected server=pi_search tools=4` and the `codemode: true` config are verified.
- `opencode mcp list` still reports no servers (2.3.2 display gap described above).
- The end-to-end rollback restore has not been executed; only the snapshot's integrity (sha256 of
  every retired file + a runnable `1.18.32` binary) was verified, so production definition-of-done
  item 3 ("rollback exercised") remains open and needs an approved maintenance window.
- The supervisor and RSI pruner have only been exercised by the offline test suite and against the
  small live audit log written by `debug` runs, not against a long real coding session.
- Benchmark percentages quoted from the Wave 1 audit remain reported, not re-verified (see
  `Decisions.md`).
