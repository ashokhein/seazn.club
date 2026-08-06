// #461 — a move returns the conflicts it already computed.
//
// `moveFixture` builds a full conflict report for the destination slot, uses it
// for `assertNoNewBlocking`, and then throws it away: the function was
// `Promise<void>`. Blocking conflicts 409, so an organiser hears about those.
// WARN-level ones — rest shortfalls, a stored typed rule, a session-window
// breach — were computed and dropped on the floor, so an API client dragging a
// card was told nothing at all about the board it had just created.
//
// THE BOARD BELOW ALSO COVERS #462's FOURTH CALL SITE. `moveFixture` is one of
// the four places sibling assignments reach the verifier, and it was the one
// site whose fix could not be asserted while the function returned nothing. The
// cap here is competition-scoped and breaks ONLY once the sibling division's
// card is counted, so a regression in either fix reds this file.
//
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import type { HardConstraint } from "@seazn/engine/scheduling";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { PatchedFixture } from "@/server/api-v1/schemas";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages } from "../stages";
import { moveFixture } from "../schedule";
import { patchFixture } from "../fixtures";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

const TZ = "Europe/London";
const GENERIC_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

const DAY = "2026-08-10";
/** A second day, well clear of the cap, for the "clean move" case. */
const OTHER_DAY = "2026-08-12";
const at = (ymd: string, hhmm: string): string => `${ymd}T${hhmm}:00.000Z`;

/** Competition-wide, count 2. This division holds one card on `DAY` and the
 *  sibling division holds one; a third lands the day over the cap. Warn-only —
 *  an instruction conflict is deliberately absent from `isBlockingConflict`, so
 *  the move is ACCEPTED and the conflicts are the only thing that can report it. */
const DAY_CAP: HardConstraint[] = [
  { type: "max_fixtures_per_day", count: 2, scope: { kind: "competition" } },
];

const SIBLING_COURT = "Far Court";

function settingsConfig(courts: string[], hard: HardConstraint[]) {
  return {
    startAt: at(DAY, "08:00"),
    matchMinutes: 30,
    gapMinutes: 0,
    courts,
    perEntrantMinRest: 20,
    blackouts: [],
    sessionWindows: [],
    constraints: {
      restMin: 20,
      noBackToBack: false,
      startWindows: [],
      fieldFairness: "off",
      parallelism: "mixed",
      crossPersonClash: "warn",
      hard,
    },
  };
}

interface Div {
  id: string;
  stageId: string;
  entrantByName: Map<string, string>;
}

async function makeDivision(
  auth: AuthCtx,
  competitionId: string,
  slug: string,
  courts: string[],
  entrantNames: string[],
  hard: HardConstraint[],
): Promise<Div> {
  const division = await createDivision(auth, competitionId, {
    name: `Div ${slug}`,
    slug,
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
    eligibility: [],
  });
  await sql`
    insert into schedule_settings (division_id, config, tz, updated_at)
    values (${division.id}, ${sql.json(settingsConfig(courts, hard))}, ${TZ}, now())
    on conflict (division_id) do update set config = excluded.config, tz = excluded.tz`;
  await createEntrants(
    auth,
    division.id,
    entrantNames.map((n, i) => ({
      kind: "individual" as const,
      display_name: n,
      seed: i + 1,
      members: [],
    })),
  );
  const rows = await sql<{ id: string; display_name: string }[]>`
    select id, display_name from entrants where division_id = ${division.id}`;
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind: "league",
    name: "RR",
    config: {},
  });
  return {
    id: division.id,
    stageId: stage!.id,
    entrantByName: new Map(rows.map((r) => [r.display_name, r.id])),
  };
}

async function addFixture(
  auth: AuthCtx,
  d: Div,
  seq: number,
  extKey: string,
  home: string,
  away: string,
  slot: { at: string; court: string } | null,
  status = "scheduled",
): Promise<string> {
  const [f] = await sql<{ id: string }[]>`
    insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key, status,
                          home_entrant_id, away_entrant_id, scheduled_at, court_label)
    values (${d.stageId}, ${d.id}, ${auth.orgId}, 1, ${seq}, ${extKey}, ${status},
            ${d.entrantByName.get(home)!}, ${d.entrantByName.get(away)!},
            ${slot?.at ?? null}, ${slot?.court ?? null})
    returning id`;
  return f!.id;
}

/** Planned division: one card already on `DAY`, one card with no slot yet.
 *  Sibling division: one fixed card on `DAY`, on a court this division does not
 *  even have — so nothing physical stands in for the rule firing. */
async function seedBoard(): Promise<{ auth: AuthCtx; planned: Div; mover: string }> {
  const { auth } = await seedOrg("pro");
  const tag = randomUUID().slice(0, 6);
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: `Move Conflicts ${tag}`,
    visibility: "public",
    branding: {},
  });
  const planned = await makeDivision(
    auth, comp.id, `planned-${tag}`, ["Court 1", "Court 2"],
    ["A-1", "A-2", "A-3", "A-4"], DAY_CAP,
  );
  const sibling = await makeDivision(
    auth, comp.id, `sibling-${tag}`, [SIBLING_COURT], ["B-1", "B-2"], [],
  );
  await addFixture(auth, planned, 0, "a-f1", "A-1", "A-2", { at: at(DAY, "09:00"), court: "Court 1" });
  const mover = await addFixture(auth, planned, 1, "a-f2", "A-3", "A-4", null);
  await addFixture(
    auth, sibling, 0, "b-f1", "B-1", "B-2",
    { at: at(DAY, "14:00"), court: SIBLING_COURT }, "finalized",
  );
  return { auth, planned, mover };
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("a move returns the conflicts it computes (#461)", () => {
  it("hands back the WARN-level conflicts a drag creates, and still writes", async () => {
    const { auth, mover } = await seedBoard();
    const conflicts = await moveFixture(auth, mover, {
      scheduled_at: at(DAY, "11:00"),
      court_label: "Court 2",
    });

    // Non-empty and non-blocking — the two halves that make this reportable
    // rather than refusable. A blocking conflict would have thrown 409 and this
    // test would never reach here.
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.blocking).toBe(false);
    expect(conflicts[0]!.code).toBe("warn.instruction");
    expect(conflicts[0]!.fixture_id).toBe(mover);
    // THREE, not two: this division's own two cards plus the SIBLING division's
    // (#462, call site four). Two would mean the sibling's card was on the board
    // as court occupancy and invisible to the rule.
    expect(conflicts[0]!.detail).toContain(`3 fixtures on ${DAY}`);

    // The write happened anyway — a warn never refuses.
    const [row] = await sql<{ court_label: string }[]>`
      select court_label from fixtures where id = ${mover}`;
    expect(row!.court_label).toBe("Court 2");
  }, 120_000);

  it("returns an empty list for a move that breaks nothing", async () => {
    // The falsifier for the test above: if `moveFixture` returned a non-empty
    // list unconditionally, or the whole board's conflicts rather than this
    // move's, the assertion above would pass while meaning nothing.
    const { auth, mover } = await seedBoard();
    const conflicts = await moveFixture(auth, mover, {
      scheduled_at: at(OTHER_DAY, "09:00"),
      court_label: "Court 2",
    });
    expect(conflicts).toEqual([]);
  }, 120_000);

  it("the PATCH payload carries them, exactly as the response schema declares", async () => {
    // `openapi:gen` regenerates the spec FROM the zod schema, and nothing applies
    // that schema at runtime — so a spec and a served body can disagree with both
    // gates green. The only thing that catches it is running the schema over the
    // real payload, which is what this does. `JSON.parse(JSON.stringify(...))` is
    // deliberate: postgres hands back `timestamptz` as a Date, and the WIRE is
    // what the schema describes.
    const { auth, mover } = await seedBoard();
    const out = await patchFixture(auth, mover, {
      scheduled_at: at(DAY, "11:00"),
      court_label: "Court 2",
    });
    const wire = JSON.parse(JSON.stringify(out));

    expect(Object.keys(wire)).toContain("conflicts");
    expect(wire.conflicts).toHaveLength(1);
    expect(wire.conflicts[0].code).toBe("warn.instruction");
    // zod STRIPS unknown keys, so an equality against the parse result fails on
    // an undocumented extra field as well as on a missing declared one.
    expect(PatchedFixture.parse(wire)).toEqual(wire);
  }, 120_000);
});
