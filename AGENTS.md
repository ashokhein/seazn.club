<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

<!-- BEGIN:session-handoff -->
## Compact instructions
When compacting, preserve: current task state, files touched this
session, decisions made, and the latest test results.
Drop: full file contents already committed, exploration dead ends,
and resolved error output.
<!-- END:session-handoff -->

<!-- BEGIN:orchestration -->
## Orchestration (long sessions)

Main thread is the orchestrator, not the reader. Every file dump pulled
into main context is a permanent tax on the rest of the session.
Delegate reads; keep decisions. Full rationale and the wave recipe:
`docs/agent-playbook.md` — read it before running a multi-task wave.

**Delegate vs inline.** Broad fan-out ("where is X", "what calls Y",
"map this dir") → `scout` or `Explore`. Scoped task with acceptance
criteria → `implementer`. Diff review before commit → `reviewer`.
Known file + known symbol + one fact → do it inline; a subagent spawn
costs more than the answer. Never delegate a search *and* run it too.

**Every dispatch carries five things** or the agent guesses: exact file
paths, acceptance criteria, what NOT to touch, the verify command to
run, and an output cap. Default cap: "final message under 15 lines —
counts, paths, deviations, blockers; no file contents or diffs."

**Parallel only when file sets are provably disjoint.** Ownership lists
do not hold: a production change routinely forces a test-file edit into
someone else's lane. Overlap → sequential, or `isolation: "worktree"`.

**Never accept "done, tests pass"** without the raw counts pasted back.
Rerun the gate yourself at the wave boundary.

## Environment setup

Standing up a local environment — a fresh DB, a worktree, a prod server
for smoke or e2e — has an ordered recipe, and several of the obvious
shortcuts return HTTP 200 or exit 0 while serving, testing or compiling
the wrong thing. **Follow the `seazn-local-env` skill**
(`~/.claude/skills/seazn-local-env/SKILL.md` — invoke it with the Skill
tool, or just read the file; it is machine-local, so a fresh clone on
another machine will not have it). Its §5 also lists the environmental
red signatures here, so an environment fault is not reported as a defect.

The two that cost the most, if you read nothing else: `db:apply` alone is
NOT a fresh schema (it needs `sync:sports`, or `funnel.test.ts` fails
`expected 'generic' to be 'badminton'`), and a `pg_ctl` that fails with
"Address already in use" is followed by a `createdb` that SUCCEEDS —
against another session's server. Confirm `show data_directory` is yours.

## Verification traps in this repo

Tool wrappers here lie in specific, repeatable ways. Assume these
before diagnosing a real bug:

- `rtk` vitest summaries print `PASS(0) FAIL(0)` for a suite that
  **failed to collect**, and swallow exit codes. Judge green only from
  `--reporter=json --outputFile` (`numPassedTests`/`numTotalTests`).
- `rtk` hides `npm run lint` output entirely; "ESLint output (JSON
  parse failed)" is the wrapper losing the result, not a clean run.
  Use `rtk proxy` and read `✖ N problems`.
- `npm test --workspace apps/web -- run <path>` treats positionals as
  **filename filters** — a typo silently runs a subset and reports
  green. Also: unset `DB_SCHEMA` and `--root` each under-report.
- `grep` reports files here as `Binary file … matches` and hides the
  lines. Always `-a` before concluding a call site does not exist.
- A killed background command reports **exit code 0** — that 0 is the
  SIGTERM. Have the command write `EXIT=$?` itself.
- **Shell cwd can reset to the main checkout between calls.** A verify
  run launched from a worktree then silently executes on `main` and
  returns a false green (12 tests, none of yours). Prefix
  `cd <abs worktree> &&` in the *same* call, and confirm the resolved
  paths in `.testResults[].name` before believing a count.
- **`git stash` in a worktree is not safe here** — the stash stack is
  shared with the main checkout. A no-op `stash push` followed by `pop`
  pops a *pre-existing foreign* stash and leaves `package.json` /
  `package-lock.json` unmerged, which blocks every commit in the tree.
- Assertions on a Next HTML body must anchor on `="` — React serialises
  an omitted prop as `"$undefined"`, so a bare `data-*` probe passes in
  both states.

## Standing project rules

- **Never enable `.github/workflows/e2e.yml`.** Disabled deliberately;
  verify e2e locally (prod build + `E2E_PROD_TARGET`).
- Smoke CI runs on **PRs only** — merging locally and pushing to `main`
  skips it. Behavior changes need a PR or a local full-smoke first.
- Every change ships a test that fails without it.
- Any new or changed user-facing string → all 4 locale dictionaries,
  never hardcoded English. `content/help/**` is the exception: one
  English tree, no i18n work owed.
- UI work is verified by screenshot at desktop **and 375px**, with no
  horizontal page scroll. `/admin` is staff-only — functional bar, skip
  design polish; every other surface keeps full polish.
- New branches go in a worktree; never check out in the main repo dir.

## Live programmes — read the index before touching their code

Some areas carry rulings that are NOT derivable from the code and that
a fresh session will otherwise re-derive wrongly. If your task touches
one, read its index first.

- **Scoring / sport modules / the scoring pad / fidelity tiers** →
  `docs/superpowers/specs/2026-08-06-scoringpad-v2-prompts/_INDEX.md`
  (decision log, false premises found, session status), then
  `_RULES.md` beside it. Design of record:
  `docs/superpowers/specs/2026-08-03-scoringpad-v2-design.md`.
  Two rulings that bite immediately: the fidelity band scale is
  **closed at 0–3** (no tier 4, ever), and engine comments citing
  **"doc 14" point at a document that does not exist** — the scale's
  semantics live in `packages/engine/src/sport/module.ts`, nowhere else.
<!-- END:orchestration -->
