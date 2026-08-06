# Standing rules — every ScoringPad v2 session

Read this file **first**, at the top of every session. Each `S*`/`L*` prompt in
this directory assumes it and does not repeat it. Then read the session's own
prompt file and `_INDEX.md` (status + decisions, survives compaction).

Programme: #407 → index #411 → waves. Design of record:
`docs/superpowers/specs/2026-08-03-scoringpad-v2-design.md`.
Superseded prompts: `2026-08-03-scoringpad-v2-wave-prompts.md` (kept for history;
its line numbers predate the 54 W4 commits — **re-pin before trusting any of them**).

---

## 1. Owner rules (non-negotiable)

- **DON'T RAISE NEW ISSUES.** Found a defect, a wrong premise in the brief, or a
  gap? **Fix it in this session.** If the fix widens the blast radius beyond this
  session's stated file set, **ask me first** — then fix. Never open a GitHub
  issue to defer it. Record every such fix in the PR body under `Unplanned fixes`.
- **Think past the literal brief.** Hunt gaps, edge cases and weak design. Propose
  the improvement, don't just implement the sentence. A brief premise that turns
  out false is a finding, not a blocker — three W4 briefs were wrong and the agents
  were right.
- **Greenfield schema.** No production data, no backfills, no compat shims. A new
  table or column is expected and cheap. Prefer the correct schema over the
  backwards-compatible one. Engine modules stay pinned at `1.0.0` — extend in
  place, never bump (`registry.get(key,version)` has no fallback).
- **One PR per session.** Smoke CI runs on **PRs only** — merging locally and
  pushing to `main` skips it.
- **New branch in a worktree**, never a checkout in the main repo dir.

## 2. Toolchain

- **TypeScript 7**, **Node 26**. Read `.claude/ts7-migration-state.md` before any
  build/typecheck work — the migration ships in 3 staged PRs and stage 1 is in
  flight; the bare `typescript` specifier and `bin.tsc` collide by install order.
- `apps/web` typecheck peaks ~2.8 GB — run it with `NODE_OPTIONS=--max-old-space-size=6144`.
- Have the command write its own status: `npx tsc --noEmit; echo "EXIT=$?"`.
  `tsc | tail` reports **tail's** status, not tsc's. Never run two concurrently.

## 3. Skills — load, don't cite

| When | Skill |
|---|---|
| every session, before code | `superpowers:test-driven-development` |
| before claiming done | `superpowers:verification-before-completion` |
| any unexpected red | `superpowers:systematic-debugging` |
| before the PR | `superpowers:requesting-code-review`, `code-review` |
| branch integration | `superpowers:finishing-a-development-branch` |
| worktree setup / red suite triage | `seazn-local-env` |
| any UI surface | `frontend-design:frontend-design` |
| browser verification | Playwright MCP (`mcp__plugin_playwright_playwright__*`) |
| any migration or SQL | `supabase:supabase-postgres-best-practices` |
| realtime / auth / SSR | `supabase:supabase` |
| any payment question | `stripe:*` — never answer billing from memory |
| symbol/type navigation | typescript-lsp |

## 4. Agent topology

- **Scout (sonnet)** — all read-only exploration, file discovery, codebase Q&A.
  Never pull file dumps into the main thread.
- **Implementer (opus, high effort)** — writes code. All skills and tools.
- **Reviewer (sonnet)** — reviews the implementer's diff, returns a gap list.
- **Loop**: implementer → reviewer → gaps → implementer → reviewer → … until the
  review is clean **and** the gate is green. The main thread reruns the gate
  itself at the session boundary; never accept "done, tests pass" without the
  raw counts pasted back.
- **Batching rule**: tasks touching the same file set → **one inline implementer
  pass**. Only dispatch parallel agents when file sets are provably disjoint.
  Overlap → sequential, or `isolation: "worktree"`.

### Dispatch brief template (copy verbatim, fill the brackets)

> Task: [one sentence].
> Files you own: [exact paths]. Do NOT touch: [paths].
> Context you need (do not re-derive): [pinned line refs, type shapes, the
> decision and its reason].
> Acceptance: [checklist]. Every change ships a test that fails without it.
> Verify with exactly: `npx vitest run --reporter=json --outputFile=/tmp/r.json <paths>`
> then `jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests}' /tmp/r.json`.
> Final message under 15 lines — counts, paths, deviations, blockers. No file
> contents, no diffs, no narration.
> Do not spawn sub-subagents. Do not open issues. If blocked, say so in one line.

Token discipline: put the facts **in the brief**. An agent that has to re-read
what the main thread already knows costs twice. Never delegate a search and also
run it yourself.

## 5. Testing — four types, every task

Acceptance is not met until all applicable types exist and pass:

1. **Unit** — pure logic, fast, no DB.
2. **E2E (Playwright)** — real browser against a prod build.
3. **Smoke** — `scripts/smoke.ts`, pro + free paths.
4. **Regression** — the specific behaviour/bug, written to fail without the change.

**Engine-only sessions have no reachable surface**, so 2 and 3 have nothing to
drive. They are not waived — they are **deferred to a named later session** and
that session's prompt lists them. Each prompt states its own mapping explicitly;
if a prompt says a type is deferred, say so in the PR body too. Never silently drop one.

Engine sessions instead owe: **conformance** (generated streams, all modules ×
variants) + **golden replay** (frozen corpora, 11 sports) + **mutation proof**
(delete the guard, watch the suite go red — restore from a `cp` backup, never
`git checkout`).

## 6. Verification — the wrappers lie here

- vitest green **only** from
  `npx vitest run --reporter=json --outputFile=/tmp/r.json <paths>` +
  `jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests}' /tmp/r.json`.
  `rtk`'s `PASS(0) FAIL(0)` can mean *failed to collect*.
- `npm test --workspace apps/web -- run <path>` treats positionals as **filename
  filters** — a typo silently runs a subset and reports green. Confirm the paths
  in `.testResults[].name` before believing a count.
- Lint via `rtk proxy npm run lint`, read `✖ N problems`. The root lint does
  **not** cover `packages/engine` — that has its own `@seazn/engine#lint`.
- `grep -a` always (this repo reports source files as `Binary file … matches`).
  Use `git grep`; a plain grep under `apps/` counts `.next/types/`.
- Worktree: symlink `node_modules` **and** `.claude/agent-memory` in. Check
  `readlink -f node_modules/@seazn/engine` points at **your** worktree, not main.
  A worktree has no `.env.local`, so DB suites skip with the total unchanged —
  only `pending` moves.
- Shell cwd resets to the main checkout between calls: prefix
  `cd <abs worktree> &&` in the **same** call.
- `git stash` in a worktree shares main's stack — do not use it.
- A killed background command reports exit 0; have it write `EXIT=$?` itself.
- **Unrelated failures**: a red suite whose files/refs this session did not touch
  → rerun once alone, then skip it and note it in the PR body. Do not chase it.

## 7. Ship checklist (every session, before the PR)

- [ ] Every change has a test that fails without it (mutation-verified where cheap)
- [ ] Full gate rerun **inline by the main thread**, counts pasted from JSON reporter
- [ ] `npx tsc --noEmit; echo "EXIT=$?"` → `EXIT=0`, heap raised
- [ ] `rtk proxy npm run lint` → `✖ 0 problems` (root **and** engine)
- [ ] **OpenAPI drift**: if any api-v1 zod schema moved, `npm run openapi:gen`;
      then `npm run i18n:gen-keys`; then `git status --porcelain` must be **empty**.
      Both gates are CI-only — a green local run without this proves nothing.
- [ ] i18n: new/changed user-facing strings in **all 4** dictionaries
      (`en`,`es`,`fr`,`nl`, flat dotted keys) + `i18n:check`. `content/help/**` is
      one English tree and owes no translation.
- [ ] UI: Playwright screenshots at desktop **and 375px**, no horizontal page
      scroll, touch-sized targets. `/admin` = functional bar only.
- [ ] UI text changed? `git grep -a` the old **and** new strings across `e2e/`
      (both phases) — text changes break e2e.
- [ ] e2e locally via prod build + `E2E_PROD_TARGET` on **`localhost`**:3100
      (`127.0.0.1` 401s every API call — Secure cookie). Never touch
      `.github/workflows/e2e.yml`.
- [ ] Help pages updated (`content/help/**`) and smoke demo extended if the
      feature is user-visible
- [ ] `_INDEX.md` in this directory updated: status, decisions taken, premises
      found false, new gotchas
- [ ] Memory written + `scripts/agent-memory-snapshot.sh` run

## 8. Compaction protocol

This programme spans many sessions and compaction will hit mid-session. Anything
decided only in conversation is lost. So:

- Write every ruling into `_INDEX.md` **as it is made**, not at the end.
- Preserve on compact: current session state, files touched, decisions, latest
  test counts. Drop: file contents already committed, dead ends, resolved errors.
- A resumed session reads, in order: `_RULES.md` → `_INDEX.md` → its own prompt
  file → the GitHub issue. Nothing else should be needed.
