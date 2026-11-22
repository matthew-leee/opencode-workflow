# Engineering Rules (global, OpenCode v2)

## 1. Ground every factual claim
- Research before asserting. Prefer primary sources: official docs, model cards, papers, source code, live schema/API output, and `pi_search` results.
- Every non-obvious factual claim carries an explicit reference — URL, file path, or pasted command output. No reference, no claim.
- Anything you could not verify is labelled **unverified**. Never present inference as observation.
- Research deliverables and high-stakes claims get an independent cross-vendor check (`fact-checker`, or `alt-reviewer` when Claude wrote the work) before they ship. Authors never sign off their own claims.

## 2. Production bar
- Real, maintainable, tested code. No prototype, stub, or happy-path shortcut presented as done.
- Cover error paths, edge cases, security, configuration, docs, and regression tests.
- Report what you actually ran, its outcome, and what remains unverified. "It compiles" is not evidence.

## 3. Live transparency
Before each major tool burst, emit two short lines:
- `Intent:` what you are about to do.
- `Check:` the next check that proves it worked.
AFK/mobile readers rely on these; keep each to one line.

## 4. Routing (primary agent decides)
- Do it yourself: ordinary edits, small diffs, quick reads.
- `worker` — routine, fully specified implementation, refactors, docs, tests. Cheap and fast.
- `escalate-opus` — same failure twice, or high blast radius (data, auth, migrations, release).
- `escalate-fable` — Opus also stuck, or genuinely frontier-hard.
- Before any commit, completion claim, or published artifact: `reviewer` audits the diff. If Claude wrote it, use `alt-reviewer` instead.
- Never use GPT-6.1 Terra, in any role.
- Subagents cannot ask the user and cannot commit. The primary agent owns questions and Git history.

## 5. Git and secrets
- Never commit or print secrets, keys, tokens, credentials, or `.env` files.
- No destructive Git operations (hard reset, `clean -fd`, force push, history rewrite), publishing, or deployment without explicit user approval.
- One logical change per commit; the message explains why.

## 6. Domain rules
Frontend/CSS, schema, and language-specific standards belong in that repository's `AGENTS.md`, not here.
