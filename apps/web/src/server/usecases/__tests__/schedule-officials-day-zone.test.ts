// An official's blackout is a CALENDAR DAY, so the query that matches it to a
// fixture must bucket on the governing clock — `settings.orgTz` — and not on
// `settings.displayTz`.
//
// The two are different objects for a reason (`ScheduleSettingsOut`'s own
// docstring: "DISPLAY ONLY. Never use it to decide which calendar day something
// is on"), and they diverge exactly when a division carries the V305 venue
// override. `displayTz` is division-override → org → UTC; `orgTz` is org → UTC,
// deliberately ignoring the override so two divisions of one competition cannot
// disagree about what day it is.
//
// THE FIXTURE HERE MAKES THEM DISAGREE, which is the whole point: a test where
// the two zones match proves nothing, because every spelling passes it. Org is
// Europe/London, the division overrides to America/New_York, and the fixture is
// at 02:00Z on 10 August 2026 — 03:00 on the 10th in London, 22:00 on the NINTH
// in New York. So:
//
//   * an official blacked out on the 10th (the org's day) must raise
//     `warn.official_unavailable`; bucketing on the display zone silently misses
//     it, and since this branch promoted that warning from an advisory badge to
//     a publish-gate input, the gate passes a board it should have queried.
//   * an official blacked out on the 9th must raise NOTHING. Without this half
//     the first case is satisfied by a query that warns on every date.
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { seedOrg, seedFutureDivision } from "@/server/usecases/__tests__/_seed";
import { putScheduleSettings, validateSchedule } from "@/server/usecases/schedule";

const HAS_DB = !!process.env.DATABASE_URL;

/** 03:00 on 2026-08-10 in Europe/London; 22:00 on 2026-08-09 in America/New_York. */
const FIXTURE_AT = "2026-08-10T02:00:00.000Z";
const ORG_DAY = "2026-08-10";
const DISPLAY_DAY = "2026-08-09";

/** Org on Europe/London, division overridden to America/New_York, one fixture at
 *  `FIXTURE_AT` with an accepted official. Returns that fixture and official. */
async function seedSplitZoneFixture(): Promise<{
  auth: AuthCtx;
  divisionId: string;
  fixtureId: string;
  officialId: string;
}> {
  const { auth } = await seedOrg("pro");
  await sql`update organizations set timezone = 'Europe/London' where id = ${auth.orgId}`;
  const { division, fixtures } = await seedFutureDivision(auth);
  // The V305 override — the only thing that makes the two zones diverge.
  await putScheduleSettings(auth, division.id, {
    config: {
      startAt: FIXTURE_AT,
      matchMinutes: 30,
      gapMinutes: 0,
      courts: ["Court 1"],
      perEntrantMinRest: 0,
      blackouts: [],
      sessionWindows: [],
    },
    tz: "America/New_York",
  });
  // `seedFutureDivision` boards every fixture a week out on Court 1; park them
  // all somewhere harmless and put exactly ONE card on the split-zone instant,
  // so no other row can supply the warning under test.
  const fixtureId = fixtures[0]!.id;
  await sql`
    update fixtures set scheduled_at = null, court_label = null
    where division_id = ${division.id} and id <> ${fixtureId}`;
  await sql`
    update fixtures set scheduled_at = ${FIXTURE_AT}, court_label = 'Court 1'
    where id = ${fixtureId}`;
  const [{ id: officialId }] = await sql<{ id: string }[]>`
    insert into officials (org_id, display_name, role_keys)
    values (${auth.orgId}, 'Zone Ref', ${sql.json(["referee"])}) returning id`;
  await sql`
    insert into fixture_officials (fixture_id, official_id, role_key, response)
    values (${fixtureId}, ${officialId}, 'referee', 'accepted')`;
  return { auth, divisionId: division.id, fixtureId, officialId };
}

async function blackout(auth: AuthCtx, officialId: string, date: string): Promise<void> {
  await sql`
    insert into official_availability (org_id, official_id, date, status, note)
    values (${auth.orgId}, ${officialId}, ${date}, 'unavailable', 'zone test')`;
}

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

describe.skipIf(!HAS_DB)("official availability buckets on the ORG zone", () => {
  it("warns when the blackout is on the fixture's day in the ORG zone", async () => {
    const { auth, divisionId, fixtureId, officialId } = await seedSplitZoneFixture();
    await blackout(auth, officialId, ORG_DAY);

    const { conflicts } = await validateSchedule(auth, divisionId);

    expect(
      conflicts.filter((c) => c.code === "warn.official_unavailable").map((c) => c.fixture_id),
    ).toEqual([fixtureId]);
  });

  it("does NOT warn when the blackout is on the DISPLAY zone's day", async () => {
    const { auth, divisionId, officialId } = await seedSplitZoneFixture();
    await blackout(auth, officialId, DISPLAY_DAY);

    const { conflicts } = await validateSchedule(auth, divisionId);

    expect(conflicts.filter((c) => c.code === "warn.official_unavailable")).toEqual([]);
  });
});
