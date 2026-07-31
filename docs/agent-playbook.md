# Agent playbook

How to run a long Claude Code session on this repo without burning the
context window, and without shipping work that only *looks* verified.

`AGENTS.md` carries the short version and is loaded into every session.
This file is the reasoning behind it plus the concrete recipes. Read it
before running a multi-task wave; you do not need it for a one-file fix.

---

## 1. The context budget is the real constraint

A long session does not end because the work is done. It ends because
the context filled with file contents that were only needed once.

The asymmetry that matters: a subagent can read forty files and return
twelve lines. Those forty files never touch the orchestrator's context.
The same reads done inline are permanent — they stay in the transcript
for the rest of the session, and they get carried through compaction.

So the rule is not "delegate more". It is: **whoever needs to hold the
decision should not be the one holding the evidence.**

### Delegate

| Work | Agent | Why |
|---|---|---|
| "where is X defined", "what calls Y", "map this dir" | `scout` | fan-out reads stay out of main context |
| broad multi-location search, unknown naming conventions | `Explore` | reads excerpts, returns locations |
| scoped task with acceptance criteria | `implementer` | TDD-shaped, project memory, verifies itself |
| diff / branch review before commit | `reviewer` | gap-hunt beyond the diff, cites `path:line` |

### Do inline

- Known file, known symbol, one fact. The spawn costs more than the answer.
- Anything where you would have to explain more context than you would
  save. If the brief is longer than the file, read the file.
- The final gate run before commit. You own that number; do not inherit it.

### Never

- Delegate a search *and* run it yourself. Pick one, wait for it.
- Re-read a file you just edited "to verify". `Edit` errors if it failed.
- Spawn a fresh agent to continue an agent's work — use `SendMessage`
  with its ID and keep its context instead of paying to rebuild it.

---

## 2. Dispatch briefs

An agent inherits none of the conversation. Everything it needs must be
in the brief. A vague brief does not produce a slow agent — it produces
confident wrong code.

Five required parts:

1. **Exact file paths.** Not "the billing usecase" — `apps/web/src/...`.
2. **Acceptance criteria.** What must be true when it is done, in terms
   that can fail.
3. **What NOT to touch.** Agents refactor adjacent code by default.
   Name the blast radius.
4. **The verify command, verbatim.** Including the reporter flags (see
   §4) and the DB env. If you do not paste the command, you will get a
   summary of a command you did not choose.
5. **An output cap.** Default:

   > Final message under 15 lines — commits, verified test counts, files
   > touched, deviations, blockers. No file contents, no diffs.

Without the cap, a competent agent returns 400 lines of the code it just
wrote, and you pay for it in the one context that cannot afford it.

For structured hand-offs, ask for a fixed shape rather than prose —
`{files: [...], cause: "...", risk: "..."}` costs a third of the same
content narrated.

---

## 3. Parallelism

Parallel agents are correct when the file sets are **provably disjoint**
— different apps, different packages, no shared test file, no shared
migration number.

They are not made safe by an ownership list. The recurring failure here:
two agents own separate production files, both changes force an edit to
the same test file or the same `openapi` regen, and the second write
silently loses the first. Migration version numbers collide the same way
(a brief's `V303` goes stale mid-wave).

When overlap is possible:

- Run sequentially. It is slower in wall-clock and faster in total work.
- Or give each agent `isolation: "worktree"` so the conflict surfaces as
  a merge instead of a silent overwrite.

Rebase at **task boundaries only** — never while an agent is mid-run.

---

## 4. Verifying a claim

An agent saying "all tests pass" is a claim about a number it read from
a wrapper. On this repo the wrappers lose that number in several
distinct ways, so the claim needs the raw evidence attached.

```bash
# Green is only green from JSON. rtk mangles --reporter=json on stdout.
npx vitest run --reporter=json --outputFile=/tmp/r.json <paths>
jq '{total: .numTotalTests, passed: .numPassedTests, failed: .numFailedTests}' /tmp/r.json
```

Why each guard exists:

- **`PASS(0) FAIL(0)` means "failed to collect", not "clean skip".** A
  syntax error — e.g. a backtick inside a SQL `--` comment, which ends
  the tagged template — collects zero tests. The wrapper prints that
  identically to success.
- **Pin `numTotalTests`, not just failures.** During a mutation sweep, a
  mutant that does not parse shrinks the total, and a shrunk total reads
  as a surviving mutant.
- **Positionals are filename filters.** `npm test --workspace apps/web
  -- run <path>` with a wrong path runs a subset and exits 0.
- **A killed background command exits 0.** For `tsc --noEmit`, an empty
  log is indistinguishable from success. Make the command write
  `EXIT=$?` itself. Never run two `tsc --noEmit` concurrently — they
  thrash `tsconfig.tsbuildinfo` and look hung.
- **`grep` masks matches as `Binary file … matches`.** Always `-a`.
- **`rtk` hides lint output.** `rtk proxy npm run lint`, read `✖ N problems`.

### Tests that cannot fail

Before trusting a green, ask whether the test *could* have gone red:

- A bare `{status: 422}` is satisfied by every guard on the path. Assert
  the error **code**.
- A symmetric fixture (two identical divisions) cannot catch
  first-row-wins bugs. Parameterise the sizes.
- A bare `data-*` probe against a Next HTML body passes in both states —
  React serialises an omitted prop as `"$undefined"`. Anchor on `="`.
- `disabled` assertions must anchor on `disabled=""`; the Tailwind class
  `disabled:cursor-not-allowed` matches a bare probe.

When a true red is impossible (audit- or coverage-shaped tests),
substitute a mutation check: break the code by hand, watch the test
fail, restore. Revert the mutation with `cp` from a backup — **never**
`git checkout <file>`, which on uncommitted work restores the index and
deletes the implementation the sweep was verifying.

---

## 5. The standard wave

```
1. inline    read the issue, form the plan, write the task list
2. scout     locate touch points → file:line list (no fixes)
3. implementer   one task, tight brief, verify command   ← sequential
4. reviewer      the diff, before commit
5. inline    fix findings, run the full gate yourself, commit
6. memory    write the decision + any new gotcha
```

Steps 3 and 4 repeat per task. Step 5 is not delegable — the number you
report to the user is the number you ran.

Write memory at decision points, not at session end. Compaction keeps
task state and test results; it does not reliably keep *why* a decision
went the way it did.

---

## 6. Agent memory

`.claude/agent-memory/` holds per-agent durable knowledge — conventions,
architecture facts, build and test gotchas. It is **excluded from git on
purpose** (`.git/info/exclude`, "SDD infra"), which means it has no
version history and no recovery path from the parent repo.

This has already cost a real loss: in July 2026 an implementer ran
`rm -rf` on the directory while cleaning up a stray path, and 23 topic
files were unrecoverable. Only the index survived, because it happened
to be in that session's context.

Durability is handled outside the repo — see
`scripts/agent-memory-snapshot.sh`. Run it at wave boundaries, or wire
it to a `Stop` hook. It snapshots into a bare repo under
`~/.claude/backups/`, so it survives `rm -rf` of the working directory.

### Worktrees start with no memory

Because the directory is untracked, `git worktree add` does not create
it. A fresh worktree has `.claude/agents/` (tracked, so the agent
definitions work) but **no `.claude/agent-memory/`** — every agent you
dispatch there begins with zero accumulated knowledge and re-derives
conventions this repo already learned. Since wave work happens in
worktrees by convention, this is the common case, not the edge case.

Link the shared directory as part of worktree setup, alongside the
`node_modules` step:

```bash
ln -s "$(git rev-parse --path-format=absolute --git-common-dir)/../.claude/agent-memory" \
      .claude/agent-memory
```

Two things follow from one backup serving every checkout:

- The snapshot script **refuses to run from a worktree that holds its
  own real `agent-memory` directory**, because committing that thin
  copy would overwrite the main checkout's snapshot. A symlinked
  worktree resolves to the same physical path and is accepted.
- `.claude/settings.local.json` is gitignored, so the `Stop` hook does
  **not** exist in a worktree. Snapshots only happen automatically from
  the main checkout — run the script by hand at the end of worktree
  work, or let the next main-checkout session pick the changes up.

What belongs there: durable conventions ("all DB access goes through
`src/db/client.ts`"), build and test gotchas, and "team decided X — stop
flagging it" rulings. What does not: task status, which belongs in the
ledger or `HANDOFF.md`.

Keep each `MEMORY.md` under 150 lines — only the first ~200 lines are
auto-loaded. Overflow goes into topic files referenced from the index.

---

## 7. Anti-patterns

- Spawning a scout for something already known — pure loss.
- A subagent returning file contents. That is a brief defect, not an
  agent defect. Add the cap.
- Re-deriving a decision from forty turns ago instead of checking memory.
- Two agents on the same test file.
- Trusting "done, all tests pass" without the counts.
- Treating an absolute-count DB test's red as a regression before
  re-running it alone — file-parallel sweeps flake those.
