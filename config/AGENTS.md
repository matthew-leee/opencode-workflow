# Engineering Rules (global, OpenCode v2)

## 1. Ground every factual claim
- Research before asserting; prefer primary sources (docs, model cards, papers, code, live schema/API, `pi_search`).
- Use `pi_search.media_search` for PDFs and media (images, diagrams, video).
- Cite every non-obvious claim (URL, file path, or command output); label unchecked claims **unverified**; never present inference as observation.
- Verify research, code, finance, health, and high-stakes claims via cross-vendor check (`fact-checker`; `alt-reviewer` if Claude authored); low-stakes casual chats are exempt. Authors never sign off their own claims.

## 2. Production bar
- Real, maintainable, tested code; no prototype, stub, or happy-path shortcut presented as done.
- Cover error paths, edge cases, security, config, docs, and regression tests.
- Report what you ran, its outcome, and what is unverified; "it compiles" is not evidence.

## 3. Live transparency
Before each major tool burst, emit two one-line markers (for AFK/mobile readers):
- `Intent:` what you are about to do.
- `Check:` the next check that proves it worked.

## 4. Routing (primary agent decides)
- **Neon tries first**, even on high-blast-radius work (backed by cross-vendor `reviewer`).
- `worker` - routine, fully specified implementation, refactors, docs, and tests.
- `escalate-opus` - ONLY on objective failure: 2 reviewer rejections with unresolved blockers, same failure twice after 2 distinct attempts, guard-detected spin, or explicit user request.
- `escalate-fable` - Opus also stuck, or genuinely frontier-hard.
- Before any commit, completion claim, or published artifact: `reviewer` audits the diff (`alt-reviewer` if Claude wrote it).
- Never use GPT-6.1 Terra in any role.
- Subagents cannot ask or commit; primary agent owns questions and Git history.

## 5. Git and secrets
- Never commit or print secrets, keys, tokens, credentials, or `.env` files.
- No destructive Git ops (hard reset, `clean -fd`, force push, history rewrite), publishing, or deploy without explicit user approval.
- One logical change per commit; message explains why.

## 6. Domain rules
Frontend/CSS, schema, and language-specific standards belong in that repo's `AGENTS.md`, not here.
