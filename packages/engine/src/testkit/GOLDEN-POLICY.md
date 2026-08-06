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
