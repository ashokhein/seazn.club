# Jul3/03 — Schedule Undo, Versioning & Safe Destructive Ops

Adds reversible editing and guarded destructive actions to the division/schedule
lifecycle. Builds on the structural ledger `division_events`
([07-greenfield-schema.md](../07-greenfield-schema.md), [05-formats-progression-tiebreakers.md](../05-formats-progression-tiebreakers.md)
§5) and the scheduling console (PROMPT-17). Design only.

## 1. Motivation & scope

Recurring, high-anxiety asks — organisers fear one click wiping days of work:

- **UNDO like Word** (16 Jun ×1) — "I'm on my 5th schedule version; try a change but revert
  if it doesn't work, without ruining earlier work."
- **Lock fixtures locally** (22 Jun ×2) — two-site tournament; restart fixtures on site A
  must not delete site B.
- **Confirm before clear + move the button** (18 May ×1) — accidental "Clear schedule"
  wipes matches on *other* venues too; separate it from "Schedule."
- **Filtered clear** (4 Jul ×2; 23 Apr) — clear by group/bracket/round/court only, not all.
- **Remove all teams in a pool, keep the pool** (2 Jul) — experiment with groupings without
  altering structure.

**In scope:** an undo/redo stack over structural edits, per-fixture/scope locking, a
scoped-clear operation (filter-aware), snapshot "save points," all built on the existing
append-only ledger. **Out:** score-event undo (already exists — `core.void`, doc 02 §6);
generic multi-user OT/CRDT (single-writer structural aggregate, doc 02 §8).

## 2. Model — undo as ledger navigation, not deletion

The division already has an append-only, hash-chained `division_events` ledger. Undo does
**not** delete rows; it appends inverse events and moves a watermark. Two columns added:

```sql
alter table divisions
  add column schedule_locked boolean not null default false,   -- whole-division freeze
  add column edit_watermark  bigint;                            -- current undo position

-- (Implementation note: both fixture columns already existed as
-- fixtures.schedule_locked — the PROMPT-17 pin, already a solver obstacle —
-- and fixtures.schedule_source; V244 adds nothing at fixture level. Scope
-- locks live in divisions.locked_scopes jsonb.)

-- named save points an organiser can restore to (16 Jun "go back to last version")
create table division_checkpoints (
  id          uuid primary key default gen_random_uuid(),
  division_id uuid not null references divisions(id) on delete cascade,
  org_id      uuid not null,
  seq         bigint not null,               -- division_events watermark captured
  label       text not null,                 -- 'before rain reshuffle'
  created_by  uuid references users(id) on delete set null,
  created_at  timestamptz not null default now()
);
```

Every reversible structural action already writes a `division_events` row
(`fixtures_generated`, `schedule_edited`, `fixture_moved`, `officials_assigned`, …). Undo =
append the paired inverse event (`fixture_moved` ↔ `fixture_moved` with swapped payload;
`fixtures_generated` ↔ `fixtures_cleared`) and advance `edit_watermark` backward. Redo
re-applies. The ledger stays gapless and hash-verified — audit intact (doc 07 note 2).

## 3. Reversible-action contract (pure, in `@seazn/engine`)

Each structural mutation declares its inverse so undo is mechanical, not bespoke:

```ts
interface ReversibleOp<P> {
  type: DivisionEventType;
  apply(state: DivisionScheduleState, payload: P): DivisionScheduleState;
  invert(payload: P, prevState: DivisionScheduleState): { type; payload };  // the undo event
}
```

`fold(division_events up to watermark)` = current schedule state (same disposable-cache
principle as `MatchState`, doc 02 §6). The engine exposes `undo(state, ledger, watermark)`
and `redo(...)` as pure functions returning the next event to append + new watermark. The
app persists the appended event under the division aggregate lock (doc 02 §8) — undo is a
normal single-writer append, so it is concurrency-safe by construction.

**Guardrail:** score events are downstream of fixtures. Undoing a `fixtures_generated` that
has *decided* fixtures beneath it is blocked (`error UNDO_BLOCKED_HAS_RESULTS`) unless the
organiser explicitly force-clears results first — never silently discard a scoresheet.

## 4. Locking (two-site safety — 22 Jun)

- **Per-fixture `locked`** — auto/clear passes treat locked fixtures as immovable obstacles
  (already the PROMPT-17 §3 `lockedAssignments` input — this wires the persisted flag into
  it). Regenerate/clear skips locked rows.
- **Scope lock** — lock by court/venue/pool: a stored predicate, not a column per fixture,
  applied as "these match a locked scope → obstacle." Lets site B stay frozen while site A
  regenerates (the exact 22-Jun scenario).
- Locked fixtures render with a pin badge (PROMPT-17 board already has pin/lock toggle).

## 5. Scoped clear + remove-teams-in-pool (2 Jul, 4 Jul)

`clearSchedule(scope)` where `scope = {stageId?, poolIds?, rounds?, courts?, excludeLocked:
true}` — mirrors the *generation* filters so you clear exactly what you can generate (4 Jul
ask). Always `excludeLocked` by default. Emits one `schedule_cleared` event carrying the
scope (fully undoable via §3).

`removeEntrantsFromPool(poolId)` (2 Jul) — detaches entrants from a pool's
`group_assignment` and deletes that pool's *undecided* fixtures, **keeping the pool and
stage**. Blocked if any pool fixture is decided (same results-guard as §3). Undoable.

## 6. API (extends doc 08 / doc 12)

```
POST /api/v1/divisions/{id}/undo            # → appends inverse event, returns new state + watermark
POST /api/v1/divisions/{id}/redo
GET  /api/v1/divisions/{id}/history         # ledger slice: label, actor, time, undoable?
POST /api/v1/divisions/{id}/checkpoints     # save point {label}
POST /api/v1/divisions/{id}/restore         # {checkpointId} → undo to that watermark (guarded)
POST /api/v1/schedule/clear                 # {scope} scoped clear (§5) — confirmation required client-side
PATCH /api/v1/fixtures/{id}                 # {locked} pin/unpin (existing route, new field)
POST /api/v1/pools/{id}/clear-entrants      # remove-teams-in-pool (§5)
```

`clear` and `restore` are the two "dangerous" endpoints — server requires an explicit
`confirm: true` body flag (double-submit guard) so a stray call can't wipe; UI adds the
confirm modal + moves the button away from "Schedule" (18 May).

## 7. Entitlements (extends doc 10)

Undo/redo + confirm-clear = **all plans** (safety is not a paywall). Named checkpoints /
version history depth (>1 restore point) and scope-locking for multi-site = Pro
(`schedule.versioning`). Aligns with `scheduling.constraints` being Pro.

## 8. Edge cases

- Undo after publish (doc 12): unpublished edits are invisible; undo across a publish
  boundary re-publishes the restored state on next publish, never silently changes the live
  public schedule.
- Concurrent editors: undo is a division-lock append; a stale client redo that conflicts
  gets `409` + refetch (optimistic token = ledger seq, doc 02 §8).
- Watermark not at ledger head (user undid, then makes a new edit) → truncate redo branch:
  append a `branch_reset` marker; older redo events remain in the immutable ledger but are
  no longer reachable (linear history, Word-like).
- Restore never deletes checkpoints created after it — you can redo forward to them.
