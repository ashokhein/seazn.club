# W1 — participants recursion + bye stripping + person identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every person rule fire on elimination brackets by giving each fixture the set of people who *could* stand in it (advancer recursion behind null slots), strip dangling bye feeders explicitly, and stop two `person_id`s for one human from silently splitting a schedule.

**Architecture:** One new pure module in `packages/engine/src/scheduling/participants.ts` (`computeParticipants`, `stripByes`) — set-valued, memoised, cycle-guarded, no wall clock, no DB. Both pack builders (`schedule-ai.ts`, `competition-schedule-ai.ts`) compute `participants` + `assumptions` into the pack; the greedy placer, `toEngineAssignments` and `toJointEngineAssignments` all read that one map, so draft and verdict cannot disagree. Identity gets one DB guard (partial unique index on `persons(org_id, user_id)`) and one scheduling-only, non-persisted same-name guard that never writes a row.

**Tech Stack:** TypeScript, vitest, zod, postgres.js, Flyway migrations (`db/migration/`), npm workspaces (`packages/engine`, `apps/web`).

## Global Constraints

Copied verbatim from the design doc (`docs/superpowers/specs/2026-07-30-scheduler-verified-output-design.md`) and issue #396. Every task's requirements implicitly include this section.

- `computeParticipants` **must stay pure and stay in `packages/engine`** — W6's solver imports it, and the engine forbids wall-clock reads.
- **Set-valued.** The source implementation keys `personOf: Map<entrantId, PersonKey>` — one person per entrant. Ours is `Map<entrantId, personId[]>` because an entrant is a team. Copied as-is it drops every roster member but one.
- **Test both directions.** A verifier that only rejects is untested where it matters most. Fixtures are the two real payloads, frozen: badminton double-elimination (single division) and Stepladder Showcase (multi division, shared player "Bobby Fischer").
- **Determinism** — the existing double-seed golden-pack test stays green. `redact()` maps UUIDs to *first-seen* placeholders (`<id:N>`), so **every new array and object-key order must sort on a stable domain key (person full_name, entrant name, ext_key) and never on a raw UUID**, and no assumption string may embed a UUID *fragment* (a sliced UUID does not match `redact`'s regex and would break the double-seed test — use `ext_key`, or the full UUID).
- **Golden pack updated exactly once**, as a deliberate reviewed diff.
- **Vitest counting** — run full suites, never path-filtered positionals; verify with `--reporter=json --outputFile` when a summary looks suspicious. `rtk` prints `PASS(0) FAIL(0)` for a suite that failed to collect.
- `grep -a` always — this repo reports files as `Binary file … matches` and hides the lines.
- Name and dob **never auto-link anything** in the database. Over-constrain the schedule, never the database.
- Registration auto-link is **out of scope** (deferred to #402). No change to `registrations.ts` write paths.
- Do **not** fix the per-division `verifyConfigFor` double-check (gap-adjacent, W4). Do **not** add feeder rest (W4). Do **not** add `tz`/`clock`/`window`/`parsed` (W2/W3).
- Any new or changed user-facing string → all 4 locale dictionaries. `content/help/**` is the exception: one English tree.
- New branches go in a worktree; never check out in the main repo dir.
- **Every DB-backed run uses a FRESH schema** (owner rule, 2026-08-02). Never reuse a long-lived test database: it accumulates stale seed rows and produces ~39 environmental failures that read exactly like a regression. A fresh schema needs **both** `db:apply` *and* `sync:sports` — without the second, the sport catalogue is unseeded and unrelated suites fail `expected 'generic' to be 'badminton'`.

### Test database recipe (used by every DB step below)

An ephemeral Postgres is already running on **port 54331** (socket dir `/tmp/seazn-pg-w1`). For each verification round, create a *new* database:

```bash
export PGURL_BASE="postgresql://postgres@127.0.0.1:54331"
DB=seazn_w1_$(git rev-parse --short HEAD)_$RANDOM
createdb -h 127.0.0.1 -p 54331 -U postgres "$DB"
export DATABASE_URL="$PGURL_BASE/$DB" DATABASE_SSL=disable
npm run db:apply && npm run sync:sports
```

Then run vitest **from `apps/web`**, never the repo root (root cwd breaks the `@/` aliases and picks up stale `.claude/worktrees` files):

```bash
cd apps/web && DATABASE_URL="$DATABASE_URL" DATABASE_SSL=disable npx vitest run <paths…>
```

Never pass test paths as positionals to `npm test --workspace apps/web` — positionals are *filename filters* there and silently run a subset while reporting green.

---

## File Structure

| File | State | Responsibility |
|---|---|---|
| `packages/engine/src/scheduling/participants.ts` | create | `ParticipantFixture`, `stripByes`, `computeParticipants`. Pure. |
| `packages/engine/src/scheduling/participants.test.ts` | create | Unit + frozen-payload tests for the two functions. |
| `packages/engine/src/scheduling/participants-rules.test.ts` | create | Both-directions proof: `validateAssignments` with participant-derived `people` accepts a valid bracket and rejects an invalid one. |
| `packages/engine/src/scheduling/index.ts` | modify | Barrel export. |
| `apps/web/src/server/usecases/schedule-ai.ts` | modify | Pack gains `participants` + `assumptions`; placer and `toEngineAssignments` read them; same-name guard. |
| `apps/web/src/server/usecases/competition-schedule-ai.ts` | modify | Joint pack twin. |
| `apps/web/src/server/usecases/__tests__/schedule-ai-pack.test.ts` | modify | Pack-shape, determinism, size-budget, name-guard tests. |
| `apps/web/src/server/usecases/__tests__/persons-identity.test.ts` | create | Index rejection + guardian anti-merge regression. |
| ~~`db/migration/v2-engine/tables/V345__persons_org_user_unique.sql`~~ | **withdrawn** | Dropped 2026-08-02 — see Task 3 banner. W1 ships no migration. |
| `content/help/**` (one article) | modify | Closing pass: what changed for organisers. |
| `scripts/smoke.ts` | modify | Behaviour changed → extend pro/free paths. |

---

### Task 1: `participants.ts` — pure recursion + bye stripping

**Files:**
- Create: `packages/engine/src/scheduling/participants.ts`
- Create: `packages/engine/src/scheduling/participants.test.ts`
- Modify: `packages/engine/src/scheduling/index.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `interface ParticipantFixture { id: string; ext_key?: string | null; home: string | null; away: string | null; feeds: { after: readonly string[] } }`
  - `function stripByes<F extends ParticipantFixture>(fixtures: readonly F[]): { fixtures: F[]; assumptions: string[] }`
  - `interface ParticipantsOptions { sortKey?: (personId: string) => string }`
  - `function computeParticipants<F extends ParticipantFixture>(fixtures: readonly F[], personsByEntrant: ReadonlyMap<string, readonly string[]>, opts?: ParticipantsOptions): Record<string, string[]>`

- [ ] **Step 1: Write the failing test**

Create `packages/engine/src/scheduling/participants.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { computeParticipants, stripByes, type ParticipantFixture } from "./participants";

// ---------------------------------------------------------------------------
// The badminton double-elimination payload, frozen. 13 fixtures, 7 entrants;
// 10 of the 13 have at least one null slot filled by whoever advances.
// `BYE-1` is a feeder that is NOT in the movable set — a bye.
// ---------------------------------------------------------------------------
const fx = (
  id: string,
  home: string | null,
  away: string | null,
  after: string[],
): ParticipantFixture => ({ id, ext_key: id, home, away, feeds: { after } });

const BADMINTON: ParticipantFixture[] = [
  fx("wb-r0-i1", "e", "d", []),
  fx("wb-r0-i2", "c", "f", []),
  fx("wb-r0-i3", "g", "b", []),
  fx("wb-r1-i0", "a", null, ["wb-r0-i1", "BYE-1"]),
  fx("wb-r1-i1", null, null, ["wb-r0-i2", "wb-r0-i3"]),
  fx("wb-r2-i0", null, null, ["wb-r1-i1", "wb-r1-i0"]),
  fx("lb-r0-i0", null, null, ["wb-r0-i1", "BYE-1"]),
  fx("lb-r0-i1", null, null, ["wb-r0-i2", "wb-r0-i3"]),
  fx("lb-r1-i0", null, null, ["wb-r1-i0", "lb-r0-i0"]),
  fx("lb-r1-i1", null, null, ["lb-r0-i1", "wb-r1-i1"]),
  fx("lb-r2-i0", null, null, ["lb-r1-i1", "lb-r1-i0"]),
  fx("lb-r3-i0", null, null, ["wb-r2-i0", "lb-r2-i0"]),
  fx("gf", null, null, ["wb-r2-i0", "lb-r3-i0"]),
];

/** One person per entrant, named after the entrant — the individual case. */
const SOLO = new Map<string, string[]>(
  ["a", "b", "c", "d", "e", "f", "g"].map((e) => [e, [`p-${e}`]]),
);

describe("stripByes", () => {
  it("strips a feeder that is not in the movable set and records an assumption", () => {
    const out = stripByes(BADMINTON);
    expect(out.fixtures.every((f) => f.feeds.after.every((id) => id !== "BYE-1"))).toBe(true);
    expect(out.assumptions).toEqual([
      "feeder BYE-1 of lb-r0-i0 is not in the movable set — treated as completed (bye or finished round)",
      "feeder BYE-1 of wb-r1-i0 is not in the movable set — treated as completed (bye or finished round)",
    ]);
  });

  it("returns the same fixture objects when nothing dangles", () => {
    const clean = stripByes(BADMINTON).fixtures;
    const again = stripByes(clean);
    expect(again.assumptions).toEqual([]);
    expect(again.fixtures[0]).toBe(clean[0]);
  });
});

describe("computeParticipants", () => {
  const P = () => computeParticipants(stripByes(BADMINTON).fixtures, SOLO);

  it("participants(gf) = all 7 entrants (full advancer recursion)", () => {
    expect(P()["gf"]).toEqual(["p-a", "p-b", "p-c", "p-d", "p-e", "p-f", "p-g"]);
  });

  it("participants(lb-r0-i0) = exactly {d, e} — only wb-r0-i1's possible losers", () => {
    expect(P()["lb-r0-i0"]).toEqual(["p-d", "p-e"]);
  });

  it("a fixture with both slots named does not recurse into its feeders", () => {
    expect(P()["wb-r0-i1"]).toEqual(["p-d", "p-e"]);
  });

  it("a half-named fixture keeps its named side and recurses for the null side", () => {
    // wb-r1-i0: home 'a' named, away fed by wb-r0-i1 (BYE-1 stripped).
    expect(P()["wb-r1-i0"]).toEqual(["p-a", "p-d", "p-e"]);
  });

  it("a team entrant with N roster members contributes all N person ids", () => {
    const roster = new Map<string, string[]>([
      ["home-team", ["p1", "p2", "p3", "p4"]],
      ["away-team", ["p5"]],
    ]);
    const fixtures = [
      fx("semi", "home-team", "away-team", []),
      fx("final", null, null, ["semi"]),
    ];
    const out = computeParticipants(fixtures, roster);
    expect(out["semi"]).toEqual(["p1", "p2", "p3", "p4", "p5"]);
    expect(out["final"]).toEqual(["p1", "p2", "p3", "p4", "p5"]);
  });

  it("deduplicates a person rostered into both entrants of one fixture", () => {
    const shared = new Map<string, string[]>([["x", ["p1", "p2"]], ["y", ["p2", "p3"]]]);
    expect(computeParticipants([fx("m", "x", "y", [])], shared)["m"]).toEqual(["p1", "p2", "p3"]);
  });

  it("a cycle in the feed graph does not hang or stack-overflow", () => {
    const cyc = [
      fx("A", null, null, ["B"]),
      fx("B", null, null, ["C"]),
      fx("C", "z", null, ["A"]),
    ];
    const out = computeParticipants(cyc, new Map([["z", ["p-z"]]]));
    expect(out["A"]).toEqual(["p-z"]);
    expect(out["C"]).toEqual(["p-z"]);
  });

  it("orders each list by the supplied sortKey, not by the raw id", () => {
    const persons = new Map<string, string[]>([["x", ["zzz", "aaa"]]]);
    const names = new Map([["zzz", "Anna"], ["aaa", "Zoe"]]);
    const out = computeParticipants([fx("m", "x", null, [])], persons, {
      sortKey: (p) => `${names.get(p)}|${p}`,
    });
    expect(out["m"]).toEqual(["zzz", "aaa"]); // Anna before Zoe
  });

  it("emits an entry for every fixture, empty when nobody is known", () => {
    const out = computeParticipants([fx("orphan", null, null, [])], new Map());
    expect(out).toEqual({ orphan: [] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace packages/engine -- run src/scheduling/participants.test.ts`
Expected: FAIL — `Failed to resolve import "./participants"`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/engine/src/scheduling/participants.ts`:

```ts
/**
 * Who could stand in a fixture — including the advancers behind a null slot.
 *
 * A TBD slot is not empty: whoever advances is a participant, and before
 * results exist the schedule must be safe for every possible outcome. Deriving
 * `people` from named entrants alone makes every person rule silently pass on
 * exactly the fixtures where a clash is most likely (10 of 13 in the badminton
 * double-elimination payload).
 *
 * Pure by contract: no DB, no provider, no wall clock. W6's repair solver
 * imports this module and must agree with the verifier on what a rule means.
 */

/** Minimal fixture shape the recursion needs. `PackFixture` satisfies it. */
export interface ParticipantFixture {
  id: string;
  ext_key?: string | null;
  home: string | null;
  away: string | null;
  feeds: { after: readonly string[] };
}

export interface StripByesResult<F> {
  fixtures: F[];
  assumptions: string[];
}

/**
 * Drop `feeds.after` ids that are not in the movable set: a bye, or a round
 * that has already finished. Recorded as an assumption rather than dropped
 * silently — `validateAssignments` tolerates a dangling dep today by accident
 * (it skips a dep whose source is not on the board), but the missing rest
 * constraint is invisible and W6's solver would deadlock on one.
 *
 * Assumption strings name `ext_key` when there is one, else the full id. Never
 * a sliced id — the pack's determinism test redacts whole UUIDs only.
 */
export function stripByes<F extends ParticipantFixture>(fixtures: readonly F[]): StripByesResult<F> {
  const present = new Set(fixtures.map((f) => f.id));
  const assumptions: string[] = [];
  const label = (f: F): string => f.ext_key ?? f.id;
  const out = fixtures.map((f) => {
    const kept = f.feeds.after.filter((id) => present.has(id));
    if (kept.length === f.feeds.after.length) return f;
    for (const id of f.feeds.after) {
      if (!present.has(id)) {
        assumptions.push(
          `feeder ${id} of ${label(f)} is not in the movable set — treated as completed (bye or finished round)`,
        );
      }
    }
    return { ...f, feeds: { ...f.feeds, after: kept } };
  });
  return { fixtures: out, assumptions: assumptions.sort() };
}

export interface ParticipantsOptions {
  /**
   * Stable sort key for a person id. Defaults to the id itself, which is fine
   * for synthetic keys but NOT for UUIDs: the pack builder passes
   * `${full_name}|${id}` so array order survives a reseed of the same board.
   */
  sortKey?: (personId: string) => string;
}

/**
 * participants(f) = persons of named home/away entrants
 *                 ∪ (if a slot is null) participants of every fixture in feeds.after
 *
 * Set-valued: an entrant is a team, so `personsByEntrant` maps one entrant to
 * many person ids and every roster member is kept. Memoised and cycle-guarded.
 */
export function computeParticipants<F extends ParticipantFixture>(
  fixtures: readonly F[],
  personsByEntrant: ReadonlyMap<string, readonly string[]>,
  opts: ParticipantsOptions = {},
): Record<string, string[]> {
  const byId = new Map(fixtures.map((f) => [f.id, f]));
  const memo = new Map<string, Set<string>>();
  const key = opts.sortKey ?? ((p: string) => p);

  const walk = (id: string, path: Set<string>): Set<string> => {
    const hit = memo.get(id);
    if (hit) return hit;
    if (path.has(id)) return new Set(); // cycle guard — feedgraph.ts flags cycles
    const f = byId.get(id);
    if (!f) return new Set();
    path.add(id);
    const out = new Set<string>();
    for (const side of [f.home, f.away]) {
      if (side !== null) for (const p of personsByEntrant.get(side) ?? []) out.add(p);
    }
    if (f.home === null || f.away === null) {
      for (const dep of f.feeds.after) for (const p of walk(dep, path)) out.add(p);
    }
    path.delete(id);
    memo.set(id, out);
    return out;
  };

  const result: Record<string, string[]> = {};
  for (const f of fixtures) {
    result[f.id] = [...walk(f.id, new Set())].sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
  }
  return result;
}
```

Note on the cycle guard and memoisation interacting: a set computed while a cycle was being unwound is memoised as computed. That matches the source implementation; `feedgraph.ts` rejects cyclic feed graphs upstream, so this path only has to be *safe*, not exact.

- [ ] **Step 4: Add the barrel export**

Modify `packages/engine/src/scheduling/index.ts` — add, keeping the file's existing `export *` style and alphabetical-ish grouping:

```ts
export * from "./participants";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test --workspace packages/engine -- run src/scheduling/participants.test.ts`
Expected: PASS, 11 tests.

Then the whole engine suite (coverage threshold is 90% lines — a new uncovered file fails the run):
Run: `npm run test --workspace packages/engine`
Expected: all suites pass.

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/scheduling/participants.ts packages/engine/src/scheduling/participants.test.ts packages/engine/src/scheduling/index.ts
git commit -m "feat(engine): set-valued, cycle-guarded participants recursion + stripByes"
```

---

### Task 2: Both-directions proof at the verifier

The point of Task 1 is that `validateAssignments` starts seeing people on TBD fixtures. This task proves it in both directions on both real payloads, and fails without Task 1.

**Files:**
- Create: `packages/engine/src/scheduling/participants-rules.test.ts`

**Interfaces:**
- Consumes: `computeParticipants`, `stripByes`, `ParticipantFixture` from Task 1; `validateAssignments`, `Assignment`, `Conflict` from `./calendar`.
- Produces: nothing (test-only).

- [ ] **Step 1: Write the failing test**

Create `packages/engine/src/scheduling/participants-rules.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { validateAssignments, type Assignment } from "./calendar";
import { computeParticipants, stripByes, type ParticipantFixture } from "./participants";

const MIN = 60_000;
const at = (iso: string): number => Date.parse(iso);

const fx = (
  id: string,
  home: string | null,
  away: string | null,
  after: string[],
): ParticipantFixture => ({ id, ext_key: id, home, away, feeds: { after } });

// --- payload A: badminton double elimination, single division -------------
const BADMINTON: ParticipantFixture[] = [
  fx("wb-r0-i1", "e", "d", []),
  fx("wb-r0-i2", "c", "f", []),
  fx("wb-r0-i3", "g", "b", []),
  fx("wb-r1-i0", "a", null, ["wb-r0-i1", "BYE-1"]),
  fx("wb-r1-i1", null, null, ["wb-r0-i2", "wb-r0-i3"]),
  fx("wb-r2-i0", null, null, ["wb-r1-i1", "wb-r1-i0"]),
  fx("lb-r0-i0", null, null, ["wb-r0-i1", "BYE-1"]),
  fx("lb-r0-i1", null, null, ["wb-r0-i2", "wb-r0-i3"]),
  fx("lb-r1-i0", null, null, ["wb-r1-i0", "lb-r0-i0"]),
  fx("lb-r1-i1", null, null, ["lb-r0-i1", "wb-r1-i1"]),
  fx("lb-r2-i0", null, null, ["lb-r1-i1", "lb-r1-i0"]),
  fx("lb-r3-i0", null, null, ["wb-r2-i0", "lb-r2-i0"]),
  fx("gf", null, null, ["wb-r2-i0", "lb-r3-i0"]),
];
const SOLO = new Map<string, string[]>(
  ["a", "b", "c", "d", "e", "f", "g"].map((e) => [e, [`p-${e}`]]),
);

const CONFIG = {
  matchMinutes: 40,
  gapMinutes: 0,
  perEntrantMinRest: 0,
  blackouts: [] as { from: number; to: number }[],
  sessionWindows: [] as { from: number; to: number }[],
};

/** Build engine assignments the way the pack does: `people` from participants. */
function assign(
  fixtures: ParticipantFixture[],
  personsByEntrant: Map<string, string[]>,
  slots: [string, string, string][], // [fixtureId, ISO start, court]
  matchMinutes = 40,
): Assignment[] {
  const stripped = stripByes(fixtures).fixtures;
  const participants = computeParticipants(stripped, personsByEntrant);
  const byId = new Map(stripped.map((f) => [f.id, f]));
  return slots.map(([id, iso, court]) => {
    const f = byId.get(id)!;
    const startAt = at(iso);
    return {
      fixtureId: id,
      court,
      startAt,
      endAt: startAt + matchMinutes * MIN,
      entrants: [f.home, f.away].filter((e): e is string => e !== null),
      people: participants[id] ?? [],
    };
  });
}

const personConflicts = (c: readonly { reason: string }[]): number =>
  c.filter((x) => x.reason === "person_overlap" || x.reason === "rest").length;

describe("participants make person rules fire on brackets (payload A: badminton)", () => {
  it("ACCEPTS a legal bracket schedule — one court, one match at a time", () => {
    const slots: [string, string, string][] = [
      ["wb-r0-i1", "2026-08-01T10:00:00Z", "Court 1"],
      ["wb-r0-i2", "2026-08-01T11:00:00Z", "Court 1"],
      ["wb-r0-i3", "2026-08-01T12:00:00Z", "Court 1"],
      ["wb-r1-i0", "2026-08-02T10:00:00Z", "Court 1"],
      ["wb-r1-i1", "2026-08-02T11:00:00Z", "Court 1"],
      ["lb-r0-i0", "2026-08-02T12:00:00Z", "Court 1"],
      ["lb-r0-i1", "2026-08-03T10:00:00Z", "Court 1"],
      ["wb-r2-i0", "2026-08-03T11:00:00Z", "Court 1"],
      ["lb-r1-i0", "2026-08-04T10:00:00Z", "Court 1"],
      ["lb-r1-i1", "2026-08-04T11:00:00Z", "Court 1"],
      ["lb-r2-i0", "2026-08-05T10:00:00Z", "Court 1"],
      ["lb-r3-i0", "2026-08-05T11:00:00Z", "Court 1"],
      ["gf", "2026-08-06T10:00:00Z", "Court 1"],
    ];
    expect(validateAssignments(assign(BADMINTON, SOLO, slots), CONFIG)).toEqual([]);
  });

  it("REJECTS two TBD fixtures that share a possible advancer at the same time", () => {
    // lb-r0-i0 can only hold d or e; wb-r1-i0 can hold a, d or e. Both slots
    // are TBD, so today's named-entrant derivation reports NOTHING here.
    const slots: [string, string, string][] = [
      ["wb-r1-i0", "2026-08-02T10:00:00Z", "Court 1"],
      ["lb-r0-i0", "2026-08-02T10:00:00Z", "Court 2"],
    ];
    const conflicts = validateAssignments(assign(BADMINTON, SOLO, slots), CONFIG);
    expect(personConflicts(conflicts)).toBeGreaterThan(0);
    expect(conflicts.some((c) => c.fixtureId === "lb-r0-i0")).toBe(true);
  });

  it("REJECTS the grand final overlapping any other fixture — gf can hold anybody", () => {
    const slots: [string, string, string][] = [
      ["gf", "2026-08-06T10:00:00Z", "Court 1"],
      ["wb-r0-i2", "2026-08-06T10:00:00Z", "Court 2"],
    ];
    expect(personConflicts(validateAssignments(assign(BADMINTON, SOLO, slots), CONFIG))).toBeGreaterThan(0);
  });

  it("does NOT reject two TBD fixtures whose advancer sets are disjoint", () => {
    // lb-r0-i0 ⊆ {d,e}; lb-r0-i1 ⊆ {b,c,f,g}. Simultaneous, different courts.
    const slots: [string, string, string][] = [
      ["lb-r0-i0", "2026-08-02T10:00:00Z", "Court 1"],
      ["lb-r0-i1", "2026-08-02T10:00:00Z", "Court 2"],
    ];
    expect(validateAssignments(assign(BADMINTON, SOLO, slots), CONFIG)).toEqual([]);
  });

  it("named-entrant derivation is what regresses: same board, people from named slots only", () => {
    // Guard that the rejection case above is genuinely new capability.
    const stripped = stripByes(BADMINTON).fixtures;
    const byId = new Map(stripped.map((f) => [f.id, f]));
    const naive: Assignment[] = [
      ["wb-r1-i0", "2026-08-02T10:00:00Z", "Court 1"],
      ["lb-r0-i0", "2026-08-02T10:00:00Z", "Court 2"],
    ].map(([id, iso, court]) => {
      const f = byId.get(id as string)!;
      const entrants = [f.home, f.away].filter((e): e is string => e !== null);
      const startAt = at(iso as string);
      return {
        fixtureId: id as string,
        court: court as string,
        startAt,
        endAt: startAt + 40 * MIN,
        entrants,
        people: entrants.flatMap((e) => SOLO.get(e) ?? []),
      };
    });
    expect(validateAssignments(naive, CONFIG)).toEqual([]); // the bug, pinned
  });
});

// --- payload B: Stepladder Showcase, two divisions, one shared human -------
describe("participants across divisions (payload B: Stepladder Showcase)", () => {
  const STEP: ParticipantFixture[] = [
    fx("sl-g1-d1", "fischer-1", "kasparov-1", []),
    fx("sl-g2-d1", "hou-1", null, ["sl-g1-d1"]),
    fx("sl-g2-d2", "polgar-2", "fischer-2", []),
    fx("sl-g3-d2", "magnus-2", null, ["sl-g2-d2"]),
  ];
  // The same human holds ONE person id here — what W1's name guard produces
  // for the pack, and what a clean database produces on its own.
  const SHARED = new Map<string, string[]>([
    ["fischer-1", ["p-fischer"]],
    ["kasparov-1", ["p-kasparov"]],
    ["hou-1", ["p-hou"]],
    ["polgar-2", ["p-polgar"]],
    ["fischer-2", ["p-fischer"]],
    ["magnus-2", ["p-magnus"]],
  ]);

  it("participants(sl-g2-d1) = {fischer, hou, kasparov} via advancer recursion", () => {
    const p = computeParticipants(stripByes(STEP).fixtures, SHARED);
    expect(p["sl-g2-d1"]).toEqual(["p-fischer", "p-hou", "p-kasparov"]);
  });

  it("REJECTS the cross-division Fischer clash on a TBD fixture", () => {
    const slots: [string, string, string][] = [
      ["sl-g2-d1", "2026-07-24T10:00:00Z", "Court 1"],
      ["sl-g2-d2", "2026-07-24T10:00:00Z", "Court 2"],
    ];
    const conflicts = validateAssignments(assign(STEP, SHARED, slots, 30), {
      ...CONFIG,
      matchMinutes: 30,
    });
    expect(personConflicts(conflicts)).toBeGreaterThan(0);
  });

  it("ACCEPTS the same pair once they are far enough apart", () => {
    const slots: [string, string, string][] = [
      ["sl-g2-d1", "2026-07-24T10:00:00Z", "Court 1"],
      ["sl-g2-d2", "2026-07-24T14:00:00Z", "Court 2"],
    ];
    expect(
      validateAssignments(assign(STEP, SHARED, slots, 30), { ...CONFIG, matchMinutes: 30 }),
    ).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace packages/engine -- run src/scheduling/participants-rules.test.ts`
Expected: FAIL before Task 1 exists. After Task 1, run it and expect PASS. If any REJECT case passes for the wrong reason (e.g. `court` rather than `person_overlap`), fix the test — `personConflicts` deliberately counts only `person_overlap` and `rest`, and every REJECT case above puts the two fixtures on *different courts*.

- [ ] **Step 3: Run the full engine suite**

Run: `npm run test --workspace packages/engine`
Expected: all suites pass.

- [ ] **Step 4: Commit**

```bash
git add packages/engine/src/scheduling/participants-rules.test.ts
git commit -m "test(engine): person rules fire on TBD bracket slots, both directions"
```

---

### Task 3: ~~Migration — partial unique index on `persons(org_id, user_id)`~~ — **WITHDRAWN 2026-08-02**

> **Owner decision, 2026-08-02: V345 is dropped from W1.** The index's premise is
> false in this codebase. One user legitimately holds several `persons` rows in one
> org — a player person and an official person — and `/me` (`listMyPersons`) returns
> them as a list with *per-person* entitlements (`hasPhotoFeature`). Evidence:
> `apps/web/src/server/usecases/__tests__/me.test.ts:162` fails with the index
> applied, and in production `inviteOfficial` (`officials.ts:155`) mints a second
> person for the same human while `acceptResolvedClaim` (`person-claims.ts:214`)
> runs a bare `update persons set user_id = …` with no `23505` handling — so a user
> who claims a player profile *and* an official profile in one org gets a 500 with
> the constraint name leaked to the caller.
>
> Consequence: #396 loses the acceptance criterion "the partial unique index rejects
> a second `persons` row with the same `(org_id, user_id)`". Stated plainly in the
> PR. The guardian anti-merge guard (Task 4) and the scheduling-only name guard
> (Task 6) carry identity for this wave; both are unaffected. The invariant question
> — *is one person per (org, user) intended, and if so do the official and player
> lanes merge?* — is filed against #404, where the merge tool lives.
>
> The steps below are kept for the record. **Do not execute them.**

#### (withdrawn) Migration — partial unique index on `persons(org_id, user_id)`

**REQUIRED SUB-SKILL:** load `supabase:supabase-postgres-best-practices` before writing the SQL.

**Files:**
- Create: `db/migration/v2-engine/tables/V345__persons_org_user_unique.sql`
- Create: `apps/web/src/server/usecases/__tests__/persons-identity.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: index `persons_org_user_uq`.

**Context an implementer needs:** `persons` (`db/migration/v2-engine/tables/V204__persons.sql`) has `user_id uuid references users(id) on delete set null`, nullable, no unique constraint and no index. Migrations are Flyway (`npm run db:apply` → `scripts/flyway.sh migrate`), highest existing is V344. Repo convention: banner header comment, prose rationale, `create ... if not exists`, plain `CREATE INDEX` (the `CONCURRENTLY` variant is a prod-side note, not a Flyway statement).

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/server/usecases/__tests__/persons-identity.test.ts`. Copy the DB-test preamble (`HAS_DB`, `sql`, `seedOrg`) from `apps/web/src/server/usecases/__tests__/schedule-ai-pack.test.ts:1-49` — reuse the same imports and helpers that file already uses rather than inventing new ones.

```ts
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
// … same HAS_DB / sql / seedOrg imports as schedule-ai-pack.test.ts

describe.skipIf(!HAS_DB)("persons identity guards (#396)", () => {
  it("rejects a second persons row with the same (org_id, user_id)", async () => {
    const { auth } = await seedOrg("pro");
    const userId = randomUUID();
    await sql`insert into users (id, email) values (${userId}, ${`u-${userId}@example.test`})`;
    await sql`insert into persons (org_id, full_name, user_id) values (${auth.orgId}, 'Claimed Once', ${userId})`;
    await expect(
      sql`insert into persons (org_id, full_name, user_id) values (${auth.orgId}, 'Claimed Twice', ${userId})`,
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("still allows many unclaimed persons — user_id null is not constrained", async () => {
    const { auth } = await seedOrg("pro");
    await sql`insert into persons (org_id, full_name) values (${auth.orgId}, 'Anon A')`;
    await sql`insert into persons (org_id, full_name) values (${auth.orgId}, 'Anon B')`;
    const [{ n }] = await sql<{ n: string }[]>`
      select count(*)::text as n from persons where org_id = ${auth.orgId} and user_id is null`;
    expect(Number(n)).toBe(2);
  });

  it("allows the same user_id in two different orgs", async () => {
    const a = await seedOrg("pro");
    const b = await seedOrg("pro");
    const userId = randomUUID();
    await sql`insert into users (id, email) values (${userId}, ${`u-${userId}@example.test`})`;
    await sql`insert into persons (org_id, full_name, user_id) values (${a.auth.orgId}, 'X', ${userId})`;
    await sql`insert into persons (org_id, full_name, user_id) values (${b.auth.orgId}, 'X', ${userId})`;
    const [{ n }] = await sql<{ n: string }[]>`
      select count(*)::text as n from persons where user_id = ${userId}`;
    expect(Number(n)).toBe(2);
  });
});
```

If the `users` insert shape above does not match this repo's `users` table, copy the exact insert used by `apps/web/src/server/usecases/__tests__/person-claims.test.ts` — that suite already creates a user and claims a person.

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/web && npx vitest run src/server/usecases/__tests__/persons-identity.test.ts
```
Expected: the first test FAILS (the duplicate insert succeeds — no constraint exists yet); the other two pass. If all three are skipped, `HAS_DB` is false: provision the local test DB first (see `project_local_test_db` recipe) — a skipped suite is not a passing suite.

- [ ] **Step 3: Write the migration**

Create `db/migration/v2-engine/tables/V345__persons_org_user_unique.sql`:

```sql
-- =============================================================================
-- V345 — one person per (organisation, claimed user)
-- =============================================================================
-- Gap 8 of the verified-schedule programme (#395/#396): the same human ends up
-- with two person_ids, so `entrant_members` shows two distinct people and every
-- cross-entrant person rule goes quiet on exactly the fixtures that need it.
--
-- `persons.user_id` is the ONE key deterministic enough to enforce in the
-- database. It is filled by the V276 claim flow; the public registration path
-- is anonymous and has no user to link (deferred: #402). Name, dob and
-- contact_email are NOT enforceable here — a guardian registering two children
-- shares one email address, and merging siblings is worse than the bug.
--
-- Partial: unclaimed persons (user_id null) are unconstrained and stay many.
-- Prod note: on a populated database create this CONCURRENTLY out of band
-- first; Flyway runs statements in a transaction, where CONCURRENTLY is
-- illegal. `if not exists` then makes this migration a no-op.
-- Pre-deploy check (must return zero rows):
--   select org_id, user_id, count(*) from persons
--    where user_id is not null group by 1, 2 having count(*) > 1;
create unique index if not exists persons_org_user_uq
  on persons (org_id, user_id)
  where user_id is not null;
```

- [ ] **Step 4: Apply and re-run**

```bash
# (fresh database from the recipe above — DATABASE_URL already exported)
npm run db:apply && npm run sync:sports   # against the FRESH database
cd apps/web && npx vitest run src/server/usecases/__tests__/persons-identity.test.ts
```
Expected: 3 passed, 0 skipped.

- [ ] **Step 5: Check the local DB has no rows the index would reject**

```bash
psql "$DATABASE_URL" -c "select org_id, user_id, count(*) from persons where user_id is not null group by 1,2 having count(*) > 1;"
```
Expected: `(0 rows)`. Record the same query in the PR body as a pre-deploy check for staging and production — if either has duplicates, the Flyway migrate will fail there and the duplicates must be merged first (#404).

- [ ] **Step 6: Commit**

```bash
git add db/migration/v2-engine/tables/V345__persons_org_user_unique.sql apps/web/src/server/usecases/__tests__/persons-identity.test.ts
git commit -m "feat(db): V345 partial unique index on persons(org_id, user_id)"
```

---

### Task 4: Guardian anti-merge regression guard

The permanent guard that the name guard never becomes a record merge: one guardian, two children, one `contact_email` ⇒ **two** `persons` rows.

**Files:**
- Modify: `apps/web/src/server/usecases/__tests__/persons-identity.test.ts`

**Interfaces:**
- Consumes: the registration confirm/materialise path in `apps/web/src/server/usecases/registrations.ts` (`materialise`, ~:391-420). **Do not modify `registrations.ts` in this wave.**
- Produces: nothing.

- [ ] **Step 1: Find the existing registration test setup**

```bash
grep -a -rn "materialise\|confirmRegistration\|registrations" apps/web/src/server/usecases/__tests__/*.test.ts | head -30
```
The end-to-end registration suite is `apps/web/src/server/usecases/__tests__/registrations.test.ts` (86K — read only the helper/setup region, not the whole file). Copy its confirm helper verbatim rather than reconstructing the insert by hand.

- [ ] **Step 2: Write the failing-if-it-ever-regresses test**

Append to `apps/web/src/server/usecases/__tests__/persons-identity.test.ts`:

```ts
describe.skipIf(!HAS_DB)("guardian anti-merge (permanent regression guard, #396)", () => {
  it("one guardian, two children, one contact_email ⇒ TWO persons rows", async () => {
    const { auth } = await seedOrg("pro");
    const divisionId = await seedOpenDivision(auth); // registration-open division
    const email = `guardian-${randomUUID().slice(0, 8)}@example.test`;
    const before = await personCount(auth.orgId);

    const one = await registerAndConfirm(auth, divisionId, {
      display_name: "Ada Guardianchild",
      contact_email: email,
      dob: "2014-03-02",
      guardian_name: "Grace Guardian",
      guardian_consent: true,
    });
    const two = await registerAndConfirm(auth, divisionId, {
      display_name: "Bob Guardianchild",
      contact_email: email,
      dob: "2016-09-11",
      guardian_name: "Grace Guardian",
      guardian_consent: true,
    });

    expect(await personCount(auth.orgId)).toBe(before + 2);
    const rows = await sql<{ id: string; full_name: string }[]>`
      select id, full_name from persons where org_id = ${auth.orgId} order by full_name`;
    expect(rows.map((r) => r.full_name)).toContain("Ada Guardianchild");
    expect(rows.map((r) => r.full_name)).toContain("Bob Guardianchild");
    expect(one.person_id).not.toBe(two.person_id);
  });
});
```

`seedOpenDivision`, `registerAndConfirm` and `personCount` are helpers to write in this file from the existing registration suite's setup; `personCount` is:

```ts
async function personCount(orgId: string): Promise<number> {
  const [{ n }] = await sql<{ n: string }[]>`
    select count(*)::text as n from persons where org_id = ${orgId}`;
  return Number(n);
}
```

If `registerAndConfirm` cannot return the created `person_id` directly, drop that last assertion and assert on the two distinct `entrant_members.person_id` values instead — never weaken the row-count assertion, which is the actual guard.

- [ ] **Step 3: Run it**

```bash
cd apps/web && npx vitest run src/server/usecases/__tests__/persons-identity.test.ts
```
Expected: PASS today (the current code never merges) — this test is the guard that keeps it that way. State plainly in the PR that it passes before and after the wave's changes; that is the point of it.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/server/usecases/__tests__/persons-identity.test.ts
git commit -m "test(registrations): guardian with two children keeps two persons rows"
```

---

### Task 5: Single-division pack — `participants` + `assumptions`, placer and verifier wired

**Files:**
- Modify: `apps/web/src/server/usecases/schedule-ai.ts` (`SchedulePack` :214-224; draft block :356-420; `packMovable` :446-470; `toEngineAssignments` :885-903)
- Modify: `apps/web/src/server/usecases/__tests__/schedule-ai-pack.test.ts`

**Interfaces:**
- Consumes: `computeParticipants`, `stripByes`, `ParticipantFixture` from `@seazn/engine/scheduling` (Task 1).
- Produces:
  - `SchedulePack.participants: Record<string, string[]>` — fixture id → person ids, every movable fixture keyed, insertion order = `packMovable` order.
  - `SchedulePack.assumptions: string[]` — sorted, UUID-free unless the whole UUID is present.
  - `toEngineAssignments` sourcing `people` from `pack.participants`.

**Ordering constraint (read before editing):** the greedy draft at :356-420 runs *before* `packMovable` is built at :446. `participants` must exist before the draft, so build `afterMap` (currently :441-444) and the participant view **above** the draft block, and reuse both below. Do not compute participants twice — the placer and the pack must be the same object, or the draft can be legal under a rule the verifier applies differently.

- [ ] **Step 1: Write the failing tests**

Add to `apps/web/src/server/usecases/__tests__/schedule-ai-pack.test.ts`, inside the existing `describe.skipIf(!HAS_DB)("buildSchedulePack (v4/01 §2)")` block:

```ts
  it("pack carries participants for every movable fixture", async () => {
    const { pack } = await buildSchedulePack(auth, divisionId, {
      mode: "generate", instruction: "Finish by 6pm.",
    });
    expect(Object.keys(pack.participants).sort()).toEqual(
      pack.fixtures.movable.map((f) => f.id).sort(),
    );
    // Round-robin board: every fixture has both slots named, so participants
    // is exactly the union of the two entrants' rosters.
    const first = pack.fixtures.movable[0]!;
    expect(pack.participants[first.id]!.length).toBeGreaterThan(0);
  });

  it("pack carries an assumptions array", async () => {
    const { pack } = await buildSchedulePack(auth, divisionId, {
      mode: "generate", instruction: "Finish by 6pm.",
    });
    expect(Array.isArray(pack.assumptions)).toBe(true);
  });
```

Add a new bracket-shaped suite in the same file (a TBD-slot board is what the round-robin seed cannot exercise). Seed it with the existing `createStages` + direct `fixtures` insert style used by `seedBigDivision`, setting `winner_to_fixture` so `feeds.after` is populated:

```ts
describe.skipIf(!HAS_DB)("buildSchedulePack on an elimination bracket (#396)", () => {
  it("participants of a TBD fixture include every possible advancer", async () => {
    const { auth, divisionId, ids } = await seedSmallBracket(); // 4 entrants: 2 semis + 1 final
    const { pack } = await buildSchedulePack(auth, divisionId, {
      mode: "generate", instruction: "Two rounds.",
    });
    const final = pack.fixtures.movable.find((f) => f.ext_key === "final")!;
    expect(final.home).toBeNull();
    expect(final.away).toBeNull();
    // Today's named-entrant derivation would give zero people here.
    expect(pack.participants[final.id]).toHaveLength(4);
    expect(new Set(pack.participants[final.id])).toEqual(new Set(ids.personIds));
  });

  it("a feeder outside the movable set is stripped and recorded in assumptions", async () => {
    const { auth, divisionId } = await seedSmallBracketWithFinishedSemi();
    const { pack } = await buildSchedulePack(auth, divisionId, {
      mode: "generate", instruction: "Two rounds.",
    });
    expect(pack.assumptions.some((a) => a.includes("treated as completed"))).toBe(true);
    for (const f of pack.fixtures.movable) {
      for (const dep of f.feeds.after) {
        expect(pack.fixtures.movable.some((m) => m.id === dep)).toBe(true);
      }
    }
  });

  it("participants stay within the token budget on a 500-fixture bracket", async () => {
    const { auth, divisionId } = await seedBigBracket(500);
    const { pack } = await buildSchedulePack(auth, divisionId, {
      mode: "generate", instruction: "Pack the day.",
    });
    expect(JSON.stringify(pack).length / 4).toBeLessThan(60_000);
  });
});
```

`seedSmallBracket` builds one division, 4 entrants each with one `persons` row and an `entrant_members` link, two semi fixtures with `winner_to_fixture` pointing at the final, and the final with both entrant slots null. `seedSmallBracketWithFinishedSemi` is the same board with one semi given `status = 'completed'` and a `scheduled_at`/`court_label` so it leaves the movable set and becomes an obstacle. `seedBigBracket(n)` extends `seedBigDivision`'s `generate_series` insert with a `winner_to_fixture` chain (fixture `g` feeds fixture `g/2`) and entrants on the leaf round only.

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd apps/web && npx vitest run src/server/usecases/__tests__/schedule-ai-pack.test.ts
```
Expected: FAIL — `pack.participants` is `undefined`; TypeScript also fails to compile the new assertions.

- [ ] **Step 3: Extend the pack type**

In `apps/web/src/server/usecases/schedule-ai.ts`, `SchedulePack` (:214-224) gains two fields, placed directly after `people`:

```ts
export interface SchedulePack {
  mode: "generate" | "refine" | "repair";
  division: { id: string; name: string; sport: string; tz: string };
  settings: PackSettings;
  entrants: PackEntrant[];
  people: PackPerson[];
  /** Every person who COULD stand in each movable fixture, including the
   *  advancers behind a null slot (#396). Keyed for every movable fixture;
   *  the source of `Assignment.people` for both the placer and the verifier. */
  participants: Record<string, string[]>;
  /** Deterministic preprocessing choices worth telling the organiser about:
   *  stripped bye feeders, same-name person grouping. Rendered at W5 (#400). */
  assumptions: string[];
  fixtures: { movable: PackFixture[]; obstacles: PackObstacle[] };
  draft: PackAssignment[];
  instruction: string;
  prior: { instruction: string; assignments: PackAssignment[] } | null;
  officials: PackOfficial[];
}
```

- [ ] **Step 4: Compute participants before the draft**

In `buildSchedulePack`, move the `afterMap` construction (currently :441-444) to just above the draft block (before `if (opts.mode === "generate")`), and add beneath it:

```ts
    // #396: who could stand in each fixture, advancers behind null slots
    // included. Computed ONCE, above the draft, so the greedy placer and the
    // verifier both read the same map — a draft legal under a rule the verifier
    // applies differently is the defect this wave exists to remove.
    const participantView: ParticipantFixture[] = movable
      .map((f) => ({
        id: f.id,
        ext_key: f.ext_key,
        home: f.home_entrant_id,
        away: f.away_entrant_id,
        feeds: { after: [...(afterMap.get(f.id) ?? [])].sort(cmp) },
      }))
      // Stable domain order so `participants` key order survives a reseed.
      .sort(
        (a, b) =>
          cmp(a.ext_key ?? "", b.ext_key ?? "") || cmp(a.id, b.id),
      );
    const stripped = stripByes(participantView);
    const participants = computeParticipants(stripped.fixtures, people, {
      sortKey: personSortKey,          // Task 6 replaces this with the name guard
    });
    const assumptions = [...stripped.assumptions];
```

`people` is the full `Map<entrantId, personId[]>` already loaded by `peopleByEntrant` earlier in the function — **not** `packPeople`, which is filtered to `ents.size >= 2` and would drop every unshared person.

`personSortKey` sorts person ids on a stable domain key. Add above, after the entrant name backfill:

```ts
    // Person ids are per-seed UUIDs; the pack's determinism test maps UUIDs to
    // first-seen placeholders, so any UUID-ordered array breaks it. Order on
    // the person's name, id last.
    const personIdsInPlay = [...new Set([...people.values()].flat())];
    const personNameById = new Map<string, string>();
    if (personIdsInPlay.length > 0) {
      const nameRows = await tx<{ id: string; full_name: string }[]>`
        select id, full_name from persons where id in ${tx(personIdsInPlay)}`;
      for (const r of nameRows) personNameById.set(r.id, r.full_name);
    }
    const personSortKey = (p: string): string => `${personNameById.get(p) ?? ""}|${p}`;
```

- [ ] **Step 5: Feed the placer from participants**

In the `mode === "generate"` draft block, replace the `people:` field of `schedulable` (:404-407):

```ts
        // was: [...(f.home_entrant_id ? people.get(...) : []), ...]
        people: participants[f.id] ?? [],
```

Leave `home`/`away`/`locked` and the domain-ranked `id` untouched.

- [ ] **Step 6: Return the new fields**

Where the function returns `{ pack, movableIds }`, add `participants` and `assumptions` to the pack literal, positioned to match the interface order (after `people`).

- [ ] **Step 7: Source `toEngineAssignments` from participants**

Replace the body of `toEngineAssignments` (:885-903):

```ts
function toEngineAssignments(plan: AiSchedulePlan, pack: SchedulePack): Assignment[] {
  const fixtureById = new Map(pack.fixtures.movable.map((f) => [f.id, f]));
  const durMs = pack.settings.matchMinutes * MS_PER_MIN;
  return plan.assignments.map((a) => {
    const f = fixtureById.get(a.fixture_id);
    const entrants = f ? [f.home, f.away].filter((e): e is string => e !== null) : [];
    const startAt = toMs(a.scheduled_at);
    return {
      fixtureId: a.fixture_id,
      court: a.court_label,
      startAt,
      endAt: startAt + durMs,
      entrants,
      // #396: participants, not named entrants — a TBD slot carries whoever
      // can still advance into it, which is what every person rule needs.
      people: pack.participants[a.fixture_id] ?? [],
    };
  });
}
```

The local `personsByEntrant` map is now dead; delete it. Import `computeParticipants`, `stripByes` and `type ParticipantFixture` from `@seazn/engine/scheduling` in the file's existing engine import group.

- [ ] **Step 8: Run the tests**

```bash
cd apps/web && npx vitest run src/server/usecases/__tests__/schedule-ai-pack.test.ts
```
Expected: PASS, including the double-seed determinism test. The snapshot test will fail with an obsolete snapshot — that is the *one* deliberate golden update: inspect the diff (it must show only `participants` and `assumptions` added, nothing reordered), then `npm run test --workspace apps/web -- run src/server/usecases/__tests__/schedule-ai-pack.test.ts -u` and commit the snapshot as part of this task.

**If the 500-fixture bracket budget test fails:** do not weaken the assertion. Report the measured `JSON.stringify(pack).length / 4` and stop for a decision — the fallback is to intern person keys per pack (`participants` referencing short pack-local keys instead of UUIDs), which changes the wire contract and needs the owner's sign-off.

- [ ] **Step 9: Full apps/web suite + typecheck**

```bash
cd apps/web && npx vitest run --reporter=json --outputFile=/tmp/w1-web.json
npx tsc --noEmit -p apps/web
```
Expected: `numFailedTests: 0`; read the JSON, not the wrapper summary.

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/server/usecases/schedule-ai.ts apps/web/src/server/usecases/__tests__/schedule-ai-pack.test.ts apps/web/src/server/usecases/__tests__/__snapshots__/
git commit -m "feat(schedule-ai): pack carries participants + assumptions; placer and verifier read them"
```

---

### Task 6: Scheduling-only same-name guard

Historic data already carries duplicates and no backfill runs in this wave. Within one scheduling run, persons whose normalised names match but whose ids differ collapse to **one synthetic key, for person rules only**. Nothing writes it; nothing renders it as a merge.

**Files:**
- Modify: `apps/web/src/server/usecases/schedule-ai.ts`
- Modify: `apps/web/src/server/usecases/__tests__/schedule-ai-pack.test.ts`

**Interfaces:**
- Consumes: `personNameById` and `participants` from Task 5.
- Produces: `function personKeyResolver(personNameById: ReadonlyMap<string, string>): { keyOf: (personId: string) => string; assumptions: string[] }` — exported from `schedule-ai.ts` so the joint builder (Task 7) reuses it verbatim.

- [ ] **Step 1: Write the failing test**

Add to `apps/web/src/server/usecases/__tests__/schedule-ai-pack.test.ts`:

```ts
describe.skipIf(!HAS_DB)("scheduling-only same-name guard (#396)", () => {
  it("two entrants, same person name, different person_id ⇒ one participant key, persons untouched", async () => {
    // Two individual entrants in one division, each with its own persons row,
    // both named "Bobby Fischer" — exactly what two anonymous registrations
    // by the same human produce today.
    const { auth, divisionId } = await seedTwoSameNamePlayers();
    const before = await personCount(auth.orgId);

    const { pack } = await buildSchedulePack(auth, divisionId, {
      mode: "generate", instruction: "Finish by 6pm.",
    });

    const f1 = pack.fixtures.movable[0]!;
    const f2 = pack.fixtures.movable[1]!;
    const shared = pack.participants[f1.id]!.filter((p) =>
      pack.participants[f2.id]!.includes(p),
    );
    expect(shared.length).toBe(1);
    expect(shared[0]).toMatch(/^name:/);
    expect(pack.assumptions.some((a) => a.includes("Bobby Fischer"))).toBe(true);

    // The database is untouched — this is a scheduling key, never a merge.
    expect(await personCount(auth.orgId)).toBe(before);
    const [{ n }] = await sql<{ n: string }[]>`
      select count(*)::text as n from persons
      where org_id = ${auth.orgId} and full_name = 'Bobby Fischer'`;
    expect(Number(n)).toBe(2);
  });

  it("two people with different names are never collapsed", async () => {
    const { pack } = await buildSchedulePack(auth, divisionId, {
      mode: "generate", instruction: "Finish by 6pm.",
    });
    expect(pack.participants).toBeDefined();
    for (const list of Object.values(pack.participants)) {
      expect(list.filter((p) => p.startsWith("name:"))).toEqual([]);
    }
  });
});
```

`seedTwoSameNamePlayers` seeds one division with two entrants that each own a distinct `persons` row with `full_name = 'Bobby Fischer'`, plus at least two fixtures that put those entrants on the board separately.

- [ ] **Step 2: Run to verify it fails**

```bash
cd apps/web && npx vitest run src/server/usecases/__tests__/schedule-ai-pack.test.ts
```
Expected: FAIL — the two ids stay distinct, `shared.length` is 0.

- [ ] **Step 3: Implement the resolver**

Add to `apps/web/src/server/usecases/schedule-ai.ts`, near the other pack helpers:

```ts
const normName = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Scheduling-only identity guard (#396, design §4.2). Persons whose normalised
 * names match but whose ids differ collapse to ONE synthetic key so person
 * rules see one human. The key never leaves the pack, nothing writes it, and
 * nothing renders it as a merge.
 *
 * The asymmetry that justifies it holds for scheduling and not for records: a
 * false merge costs one unnecessary rest gap, a false split books one human on
 * two courts. Over-constrain the schedule, never the database.
 */
export function personKeyResolver(personNameById: ReadonlyMap<string, string>): {
  keyOf: (personId: string) => string;
  assumptions: string[];
} {
  const byName = new Map<string, string[]>();
  for (const [id, name] of personNameById) {
    const k = normName(name);
    if (k === "") continue;
    (byName.get(k) ?? byName.set(k, []).get(k)!).push(id);
  }
  const synthetic = new Map<string, string>();
  const assumptions: string[] = [];
  for (const [norm, ids] of [...byName.entries()].sort(([a], [b]) => cmp(a, b))) {
    if (ids.length < 2) continue;
    for (const id of ids) synthetic.set(id, `name:${norm}`);
    assumptions.push(
      `'${personNameById.get(ids[0]!)}' matches ${ids.length} person records by name — ` +
        `treated as one player for scheduling only; no records were merged`,
    );
  }
  return { keyOf: (id) => synthetic.get(id) ?? id, assumptions };
}
```

- [ ] **Step 4: Wire it into the pack builder**

In `buildSchedulePack`, between `personNameById` and `computeParticipants`:

```ts
    const identity = personKeyResolver(personNameById);
    // Map every entrant's roster through the guard BEFORE the recursion, so a
    // collapsed pair is one key everywhere it appears.
    const guardedPeople = new Map<string, string[]>(
      [...people].map(([entrantId, ids]) => [
        entrantId,
        [...new Set(ids.map(identity.keyOf))],
      ]),
    );
```

`computeParticipants` then takes `guardedPeople`, and its `sortKey` becomes:

```ts
    const personSortKey = (p: string): string =>
      p.startsWith("name:") ? `${p.slice(5)}|${p}` : `${personNameById.get(p) ?? ""}|${p}`;
```

and `assumptions` becomes `[...stripped.assumptions, ...identity.assumptions]`.

Leave `packPeople` (the wire `people` array) built from real `person_id`s — the synthetic key is for `participants` only.

- [ ] **Step 5: Run the tests**

```bash
cd apps/web && npx vitest run src/server/usecases/__tests__/schedule-ai-pack.test.ts
```
Expected: PASS. The snapshot must NOT change again — the round-robin seed has no duplicate names. If it does change, a real ordering regression has been introduced; investigate before updating.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/server/usecases/schedule-ai.ts apps/web/src/server/usecases/__tests__/schedule-ai-pack.test.ts
git commit -m "feat(schedule-ai): scheduling-only same-name person guard, non-persisted"
```

---

### Task 7: Joint pack — `participants` + `assumptions` across divisions

The cross-division sharer is invisible in single-division mode by construction; the joint runner is the only place it can be seen.

**Files:**
- Modify: `apps/web/src/server/usecases/competition-schedule-ai.ts` (`CompetitionPack` :182-199; persons load :588-604; fixtures assembly :480-489; `toJointEngineAssignments` :741-780)
- Modify: `apps/web/src/server/usecases/__tests__/competition-schedule-pack.test.ts` (the joint pack suite; `buildCompetitionPack` is exported at `competition-schedule-ai.ts:221`). `competition-schedule-verify.test.ts` covers the joint verifier and must stay green.

**Interfaces:**
- Consumes: `computeParticipants`, `stripByes`, `ParticipantFixture` (Task 1); `personKeyResolver` exported from `schedule-ai.ts` (Task 6).
- Produces: `CompetitionPack.participants: Record<string, string[]>` and `CompetitionPack.assumptions: string[]`, with the same semantics as the single pack.

- [ ] **Step 1: Write the failing test**

In the joint pack test suite:

```ts
  it("joint pack participants collapse a cross-division same-name player (#396)", async () => {
    // Bobby Fischer registered anonymously in both divisions ⇒ two persons
    // rows. Single-division mode cannot see this pair; the joint runner must.
    const { auth, competitionId, divisionIds } = await seedTwoDivisionsSharedName();
    const { pack } = await buildCompetitionPack(auth, competitionId, {
      mode: "generate", instruction: "Finals on Friday.", division_ids: divisionIds,
    });
    const d1Fixture = pack.fixtures.movable.find((f) => f.division_id === divisionIds[0])!;
    const d2Fixture = pack.fixtures.movable.find((f) => f.division_id === divisionIds[1])!;
    const shared = pack.participants[d1Fixture.id]!.filter((p) =>
      pack.participants[d2Fixture.id]!.includes(p),
    );
    expect(shared).toHaveLength(1);
    expect(pack.assumptions.some((a) => a.includes("Bobby Fischer"))).toBe(true);
  });

  it("joint pack keys participants for every movable fixture", async () => {
    const { auth, competitionId, divisionIds } = await seedTwoDivisionsSharedName();
    const { pack } = await buildCompetitionPack(auth, competitionId, {
      mode: "generate", instruction: "Finals on Friday.", division_ids: divisionIds,
    });
    expect(Object.keys(pack.participants).sort()).toEqual(
      pack.fixtures.movable.map((f) => f.id).sort(),
    );
  });
```

Match the real `buildCompetitionPack` signature found in the file — the option names above are indicative, the suite's existing calls are authoritative.

- [ ] **Step 2: Run to verify it fails**

```bash
cd apps/web && npx vitest run src/server/usecases/__tests__/competition-schedule-pack.test.ts
```
Expected: FAIL — `pack.participants` undefined.

- [ ] **Step 3: Implement**

- `CompetitionPack` gains `participants: Record<string, string[]>` and `assumptions: string[]`, placed after `people`, with the same doc comments as the single pack.
- After the joint `movable` array is assembled (:480-489) and `membersByEntrant` is loaded (:588-604), build the same three things the single builder does, over the **union** of divisions: `personNameById` (one query over every person id in `membersByEntrant`), `personKeyResolver`, `guardedPeople`, `stripByes`, `computeParticipants`. The union is what makes the cross-division Fischer visible.
- `toJointEngineAssignments` sources `people` from `pack.participants[a.fixture_id] ?? []` and drops its local `personsByEntrant`. Leave `minutesByDivision`, the `JOINT_ASSIGNMENT_UNKNOWN` guard and `divisionId` untouched.
- Per-division sub-packs built by `buildSchedulePack` keep their own `participants`; the joint pack's map wins for joint verification. Do **not** change `verifyConfigFor` (W4).

- [ ] **Step 4: Run the tests**

```bash
cd apps/web && npx vitest run src/server/usecases/__tests__/competition-schedule-pack.test.ts
```
Expected: PASS. Then the full apps/web suite as in Task 5 Step 9.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/server/usecases/competition-schedule-ai.ts apps/web/src/server/usecases/__tests__/
git commit -m "feat(competition-schedule-ai): joint pack participants + cross-division name guard"
```

---

### Task 8: Closing pass — smoke, help, i18n, full verification

**REQUIRED SUB-SKILL:** `superpowers:verification-before-completion` before any success claim.

**Files:**
- Modify: `scripts/smoke.ts`
- Modify: one article under `content/help/**`
- Verify only: `apps/web/src/dictionaries/**`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing new.

- [ ] **Step 1: Extend the smoke script**

```bash
grep -a -n "schedule\|ai" scripts/smoke.ts | head -40
```
Find the AI-scheduling section on the pro path and add an assertion that the built pack carries `participants` for a bracket fixture with a null slot, and that `assumptions` is an array. Keep the free path's existing behaviour. If the smoke script never builds a pack, add the smallest assertion that exercises the new field via whatever entry point it does use, and say so in the PR rather than inventing a new smoke stage.

Run: `npm run smoke` (or the repo's documented full-smoke command).
Expected: pro and free paths both green.

- [ ] **Step 2: Help pages**

```bash
grep -a -rln "AI schedule\|AI scheduling\|schedule assistant" content/help | head
```
In the article that describes AI scheduling, add a short paragraph in the existing voice: matches whose players are not yet decided are now checked against everyone who could still reach them, and two entries with the same name are treated as one player when the schedule is built (records are never merged). English tree only — `content/help/**` owes no i18n work.

Run whatever help-integrity check exists (`grep -a -rn "copy-truth" scripts package.json`) and keep it green.

- [ ] **Step 3: i18n check**

No new user-facing UI string ships in this wave (`assumptions` renders at W5/#400). Prove it rather than assert it:

```bash
npm run i18n:check
```
Expected: no new missing keys attributable to this branch (stub-dict `[i18n] missing key` noise is pre-existing and benign).

- [ ] **Step 4: Full gates, read the raw numbers**

```bash
npx tsc --noEmit -p apps/web
npm run test --workspace packages/engine -- --reporter=json --outputFile=/tmp/w1-engine.json
cd apps/web && npx vitest run --reporter=json --outputFile=/tmp/w1-web.json
rtk proxy npm run lint
```
Read `numPassedTests` / `numTotalTests` / `numFailedTests` out of both JSON files and the `✖ N problems` line from lint. `PASS(0) FAIL(0)` from a wrapper summary is a collection failure, not a pass.

- [ ] **Step 5: Commit and open the PR**

```bash
git add -A
git commit -m "chore(w1): smoke + help closing pass"
git push -u origin feat/w1-participants-identity
gh pr create --title "W1: participants recursion + bye stripping + person identity (#396)" --body "…"
```

PR body must carry: the acceptance-criteria checklist from #396 with evidence per line, the raw test counts, the golden-snapshot diff rationale (one field added, nothing reordered), the measured 500-fixture bracket pack size, and the pre-deploy duplicate check for V345 (`select org_id, user_id, count(*) … having count(*) > 1` must return zero rows on staging and production before deploy).

---

## Self-Review

**Spec coverage vs #396 acceptance criteria:**

| Criterion | Task |
|---|---|
| `participants(gf)` = all 7 badminton entrants | T1 Step 1 |
| `participants(lb-r0-i0)` = exactly `{d, e}` | T1 Step 1 |
| Team entrant with N roster members contributes all N | T1 Step 1 |
| Cycle does not hang or stack-overflow | T1 Step 1 |
| Dangling `feeds.after` stripped + assumption | T1 Step 1, T5 Step 1 |
| ~~Partial unique index rejects duplicate `(org_id, user_id)`~~ | **WITHDRAWN** — see Task 3 banner; criterion dropped by owner decision 2026-08-02 |
| Guardian, two children ⇒ TWO persons rows | T4 |
| Same name, different `person_id` ⇒ conflict fires, row count unchanged | T6 (single), T7 (cross-division), T2 (verifier direction) |
| Golden pack updated exactly once | T5 Step 8 |
| Double-seed determinism stays green | T5 Step 8, enforced by `personSortKey` |
| Both directions on both real payloads | T2 |
| Pack + placer + `toEngineAssignments` + joint twin read `participants` | T5, T7 |

**Out of scope, deliberately absent:** registration auto-link (#402), feeder rest and delta-blocking (W4), `tz`/`clock`/`window`/`parsed` (W2/W3), assumptions UI (W5/#400), `verifyConfigFor` per-division double-check (W4).

**Resolved during execution (owner decision, 2026-08-02):** the 500-fixture bracket
measured **100,252** proxy tokens against the 60,000 ceiling (participants alone were
48,902 across 4,490 person-id entries; the same board is 51,350 *without* them, i.e.
already at 86% of budget before this wave). Decision: `participants` and `assumptions`
stay on the pack object for the placer and the verifier but are **stripped from the
model payload** by a `toModelPayload(pack)` serialiser. W1 therefore changes what is
*enforced*, not what the model sees — which is what §3.1 of the design says W1 should
do. The model gets the advancer *rule* in W3 via the §7.3 prompt paragraph. The
pre-existing 86%-of-budget headroom on a 500-fixture bracket is a scaling finding to
file separately, not a W1 defect.

**Known risk carried into execution:** the 500-fixture bracket token-budget measurement (T5 Step 8). Participant sets on a deep bracket grow as O(n log n) in total, and `participants` is inside `JSON.stringify(pack)`, which is the model payload (`schedule-ai.ts:1072`). The plan measures it rather than assuming; if it exceeds 60k proxy tokens the fallback (interned pack-local person keys) changes the wire contract and stops for a decision.
