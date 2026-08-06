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
   moved, and whether `outcome` / `summary` / `deltas` moved. Since scope item 3
   it also reports which of those steps are stored **only as a digest**, where no
   key can be named; see "Per-step digests" below for the residual and for how to
   recover the detail. It is a returned
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

# Per-step digests (#429 scope item 3)

The corpora recorded a full `JSON.stringify(state)` after every event. That came
to **4,507,821 bytes** across the eleven single-line files — cricket alone
1,865,370 of it — and roughly 90% of that weight was the states. (The issue body
says 2.2 MB; that is stale by about 2×, grown by sanctioned `EXTEND_GOLDEN`
passes since W4. Measure before quoting it.)

A step is now stored **either** as its full recorded state **or** as a digest of
it: `#` followed by 16 hex characters of SHA-256. `#` is not valid JSON, which is
load-bearing — every reader that walks the recorded states for a shape already
parses inside a `try/catch { continue }`, so each one skips a digest-only step
without being taught about digests at all.

## What this costs, first

Scope item 1 made **"reviewed as a state diff"** the core of the re-baseline
policy, and scope item 3 deletes the states that summary is made of. A digest
says **that** a step moved and never **what** moved: only the digest was stored,
so the previous value is a hash in git too. `corpusStateDiff` cannot name a key
for such a step and does not pretend to — it reports the step as moved, lists it
under `digestOnlySteps`, and the printout says where the detail can be had.

The bound on that cost is one fact: **the corpus still stores the `config`, the
`lineups` and every `event`, so the full state at any step is recomputable
locally.**

    recomputeStream(module, corpus.configs[stream.config], stream.events, stream.lineups).states[N]

A digest mismatch prints that line, with the step index filled in and the nearest
stored full state named.

## Which states are kept, and why those

Not a stride someone liked. Three clauses, each with a job:

1. **The first and last step of every stream, always.** The first carries the
   config the corpus was frozen against — `recordedCfgOf` reads it, and the
   config-subset pin lives there. The last is the state `outcome`, `summary` and
   `deltas` are derived from.
2. **Every `ANCHOR_STRIDE`-th step**, currently every 10th. This is the
   localisation budget: a reviewer looking at a moved digest is never more than
   ten steps from a stored full state in either direction, and the harness names
   the nearest one.
3. **Every step at which the stream's state SHAPE grows** — that is, introduces
   a `path`/`kind` pair no earlier step of that stream did. This is the clause
   that makes the anchor set deliberate. Both gates that walk the recorded states
   union a path set over them: `recordedStatePaths`, which feeds the state half
   of the additive tripwire, and `stateShapeOf`, whose output is committed as
   `<key>.schema.json` under a **byte-equality CI gate**. Keeping exactly the
   steps that ADD to that set preserves both outputs *by construction*, so
   slimming cannot quietly narrow a different tripwire or drop eleven schema
   snapshots on the floor. `golden-slim.test.ts` proves it for all eleven
   modules rather than assuming it; deleting the clause reds football, icehockey
   and hockey.

`outcome`, `summary` and `deltas` are **never** digested. They are a few hundred
bytes per stream against the states' several thousand, and they are what
standings are computed from.

## What this does not cost

The digest is taken over `comparableStateText` — **the exact text the byte-exact
half of `stateMismatch` compares**, with the module's config replaced by its
placeholder. Two consequences, both deliberate:

- **It is order-sensitive.** It hashes the recorded source text member by member
  in the recorded order. The comparison it replaces was byte-exact including key
  order, and the folds are deterministic, so replay reproduces that order
  exactly; an order-insensitive digest would be strictly *weaker* than what it
  replaces for no benefit at all. In particular it still reds on a reordering of
  integer-like keys, which is the defect scope item 4b fixed.
- **It keeps the config-subset tolerance**, which is permanent. Hashing the raw
  state instead would red all eleven corpora the next time a knob gains a
  `.default()`.

The one place the config pin is genuinely weaker: a **digest-only step is
config-blind**, because the config is placeholdered out before hashing. That
costs nothing, and the reason is structural — no fold rewrites the config, so
every state in a stream carries the same one, and step 0 is always an anchor. A
changed value on a recorded config key still reds, at step 0, in both forms.

## The mutation list is the acceptance gate

`golden-mutations.ts` is a committed, documented list of every class of
back-compat break the corpus is supposed to catch: the classes W4 threw at it (a
changed fold value, a dropped / added / reordered state key, a changed outcome,
a changed delta, a truncated stream, a changed event payload) and the two
defects proven while closing #429 (the config located by the module rather than
by the spelling `cfg`; the `JSON.parse` round trip that normalised integer-like
key order).

Each entry is applied as a **perturbation of the replayed result** rather than as
a source edit, so the whole list runs in the normal suite, and it is run through
`verifyStream` — the same function the replay test calls, not a re-implementation
of it that could drift green. `golden-mutations.test.ts` runs every entry against
the committed corpus in **both** storage forms and requires a red in both. The
state-level entries are aimed at a step the full corpus stores whole and the slim
corpus stores as a digest; that is the only step where the two forms could
disagree, so aiming anywhere else would make the file vacuous.

`CORPUS_TOLERANCES` is the control: an unmutated replay and an additive config
knob must stay green in both forms. Without it a gate that reds on everything
would kill every entry in the list and guard nothing.

One entry is recorded as **`killedBy: "schema-snapshot"`** rather than by the
corpus: narrowing football's `abandonPolicy` enum. Every football stream records
`"replay"`, so the frozen states pin that one member and dropping any other moves
no recorded state — all eleven corpora stay green. The schema snapshot records
the declaration instead of a replay, so the narrowing is a removed line there.
The test asserts that blindness (one recorded value against several declared
members) instead of describing it, because "this gate cannot see X" is exactly
the kind of claim that rots into folklore.

# Schema snapshots (#429 scope item 2)

The corpora close that coverage gap one stream at a time. The committed
`sports/**/<key>.schema.json` files close the other half of it in one move, by
recording the **declaration** instead of a replay.

    npm run schema:snapshot --workspace packages/engine

One file per module, next to its corpus, on the same naming convention.
`src/testkit/schema-snapshot.test.ts` fails when a committed file no longer
matches the live schemas, and `.github/workflows/ci.yml` runs the same
regenerate and requires `git status --porcelain` to come back empty — so a
narrowing cannot land unregenerated and unread.

Regenerating a snapshot is **routine and safe**, unlike re-baselining a corpus:
a snapshot holds no recorded behaviour, so it cannot launder a fold change. The
review artefact is the diff. Added lines are a widening; **removed lines are a
narrowing**, and that is the case this exists to make visible. The staleness
failure counts the removals for exactly that reason.

## What each of the three sections covers

**`configSchema` and `eventSchema` — complete, and independent of coverage.**
`z.toJSONSchema(schema, { io: "input" })`. Every knob, every enum member, every
bound and every union branch appears whether or not a stream ever exercised it,
which is precisely what the corpora cannot say. Drop a member from a config
enum and the snapshot loses a line even though all eleven corpora stay green.

Two pins worth knowing before changing them:

- `io: "input"`, not the zod default of `"output"`. The contract this guards is
  what the engine will **accept** — an event payload recorded last season must
  still parse — and that is the input schema. The output schema differs in the
  other direction (a `.default()` knob is required on the way out, optional on
  the way in), so it would report an additive default as a change to a
  `required` set.
- `unrepresentable` is left at "throw". A schema construct JSON Schema cannot
  express should fail the regenerate loudly rather than degrade to `{}` and
  quietly stop guarding that subtree.

**`state.paths` — structural, and the weakest of the three. Read this before
trusting it.** `SportModule<Cfg, Ev, State>` declares `configSchema` and
`eventSchema` only; there is no `stateSchema`, and every State is a plain TS
interface never validated at runtime. So the state section is derived by
walking values, not a declaration, and its claims are correspondingly narrow.

It **does** cover:

- every dotted path reachable from `init` under every config the corpus
  records, plus every path any recorded per-event state writes;
- the JSON **kind** at each path (`string`/`number`/`boolean`/`null`/`object`/
  `array`), unioned across every state that wrote it — so `winner` recorded as
  both `null` and `string` says so.

It does **not** cover:

- **any path no corpus state and no `init` ever writes.** This is the same
  coverage limit the corpora have, inherited wholesale. A conditional state
  field that no stream reaches is absent from the snapshot, and stays absent
  when it is removed. Only the two zod halves are coverage-independent.
- **values, bounds, enums or optionality.** A path is present or absent; there
  is no "this number is 0..99" and no "this key is optional". A field that
  becomes conditional does not move the snapshot.
- **which object is a record and which is a struct.** Person- and entrant-keyed
  maps collapse to a `[]` segment, as they do in the golden state walk and for
  the same reason: keying a record by its ids turns lineup data into schema
  paths that name no field. So `batterRuns[]` covers every player at once.
- **the two side keys.** `home`/`away` maps are symmetric by construction, so
  they collapse to `[]` too — otherwise a seed that sin-binned an away player
  and not a home one reads as a shape difference.
- **the module's own config**, which is dropped at the root of the state walk
  (located by identity via `configStateKey`, never by the spelling `cfg`). The
  `configSchema` section already owns every knob in it.

The state section is therefore best read as a *shape inventory*, not a schema.
Its one real guarantee is that a **rename or removal** of a covered path shows
up as a removed line.

## Determinism, because the CI gate is byte equality

Two rules, applied everywhere:

1. object keys sorted by UTF-16 code unit — never `localeCompare`, which is
   locale-dependent and would make the gate machine-dependent;
2. the two JSON Schema keywords whose arrays are **sets**, `required` and
   `enum`, sorted too, so reordering a zod object's properties is not a diff.
   Every other array keeps its order: `anyOf` and `prefixItems` are positional
   and reordering them is a real change.

Pretty-printed at 2 spaces and newline-terminated, unlike the corpora — these
files are meant to be read in review, and they are ~123 KB across all eleven.
`schema-snapshot.test.ts` asserts a rebuild of every real module is
byte-identical to the first build, because a gate that can differ from itself
reds at random.
