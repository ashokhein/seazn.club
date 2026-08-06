# Golden corpus write policy

The eleven `sports/**/<key>.golden.json` files are the engine's only
back-compat tripwire. The fast-check conformance kit generates its streams at
run time, so it re-derives its inputs from whatever the schemas currently are
and structurally cannot prove that a schema change was additive. The frozen
corpora can, and only for as long as they are not rewritten casually.

## The policy

> A re-baseline is legitimate only when it is **deliberate, isolated in its own
> commit, and reviewed as a state diff.** Never a side effect of another
> change; never `UPDATE_GOLDEN=1` run to clear a red.

`UPDATE_GOLDEN=1` reached for to make a red suite green is the specific failure
this exists to stop. It does not fix anything — it deletes the evidence, and it
deletes it silently, because a regenerated corpus is green against the code that
broke it by construction.

## The three write modes

| env | what it writes | when |
| --- | --- | --- |
| `UPDATE_GOLDEN=1` | re-records **everything** from the generator | a corpus being built from nothing. Almost never. |
| `REBASELINE_GOLDEN=1` | the same recorded **events**, with states / outcome / summary / deltas recomputed | an **intended** fold change. The commit diff is then the behaviour change itself. |
| `EXTEND_GOLDEN=1` | **appends** streams covering uncovered fidelity-tier types and optional fields | a coverage gap. Never touches an existing stream. |

If a golden is red and the fold change was **not** intended, the corpus is
right and the code is wrong. Fix the code.

If the fold change **was** intended, `REBASELINE_GOLDEN=1` is the honest tool
and `UPDATE_GOLDEN=1` is not: a re-baseline keeps every recorded event byte for
byte, so the diff is the behaviour change and nothing can hide inside a fresh
generator walk. `rebaselineCorpus` also writes the **recorded** config back into
each state, so a re-baseline cannot launder a changed config value — it can
leave a red red, it cannot turn a red green.

## What the harness enforces

Prose in a comment enforced none of this, so the harness now does.

1. **Isolated in its own commit.** `UPDATE_GOLDEN=1` and `REBASELINE_GOLDEN=1`
   both refuse to run unless every dirty path in the working tree is one of the
   corpus files the run is about to rewrite. The refusal names the offending
   paths. Outside a git checkout the run **fails closed** — with no diff there
   is nothing to review, so the run cannot satisfy the clause it is gated on.
   The check is `corpusWriteVerdict`, a pure function over a
   `git status --porcelain` listing; `corpusWriteGuard` wires the real probe in.

   The practical consequence: commit or stash your work first, run the
   re-baseline into a clean tree, and commit the corpus **alone**.

2. **Reviewed as a state diff.** A re-baseline prints `corpusStateDiff` — per
   module and per stream, which step indices moved, which top-level state keys
   moved, and whether `outcome` / `summary` / `deltas` moved. It is a returned
   data structure first and a printout second, so it is asserted on in
   `golden-policy.test.ts` without running a re-baseline. The distinct set of
   moved state keys is the last line because that is the minimality claim a
   reviewer actually checks: a fold change to the shoot-out should not move
   `cards`.

3. **The ledger is preserved.** The run asserts that every recorded `events`
   array is unchanged, and `corpusStateDiff.eventsMoved` says so independently.
   A re-baseline that moves an event is a re-record wearing a re-baseline's
   name.

## How the comparison actually works

`stateMismatch` is the whole tripwire, and what it does and does not catch is
worth knowing before adding a gate that restates it more weakly.

- **Everything outside the module's config: exact, on the recorded bytes.** Key
  order included. So for any state path some stream writes, both directions
  already red.
- **The config: a subset.** Every key the golden recorded must still be present
  with an identical value; extra keys are fine. This tolerance is **permanent
  and cannot be narrowed**: a zod `.default()` on an additive knob shifts the
  resolved config in every frozen state while changing no fold, and without the
  tolerance the period family had to route around the harness with a
  compile-time preset instead of a config field.

Two consequences that have bitten:

- **The config's location comes from the module, never from the name `cfg`**
  (`configStateKey`). `init` is handed the parsed config and the top-level state
  entry that *is* that object is where it lives. A nested key spelled `cfg` is
  part of the fold and gets no tolerance; a module filing its config under
  another name still gets one. Keying on the spelling meant the rule was about
  a name rather than about the config.
- **The comparison never round-trips the state through `JSON.parse`.**
  `JSON.parse` reorders integer-like keys — array-index-like own keys come
  first, ascending, whatever the text said — so parsing both sides and
  re-serialising normalises them identically and a real order change compares
  **equal**. `jsonObjectMembers` splits the source text instead. No corpus has
  an integer-like state key today; that is why this had to be fixed before one
  does, since the failure mode is a gate reporting success.

**Therefore the only real gap is coverage.** A field no stream writes is
invisible to a byte-exact comparison. Every "the tripwire missed X" finding
reduces to "no corpus exercises X", never to "the comparison is too weak" —
fix it with a `COVERAGE_CONFIGS` entry plus `EXTEND_GOLDEN=1`, not with a new
comparison.
