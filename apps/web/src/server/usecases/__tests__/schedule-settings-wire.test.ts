// The WIRE contract of GET/PUT /api/v1/divisions/{id}/schedule-settings.
//
// The route returns `getScheduleSettings` / `putScheduleSettings` unmapped, so
// whatever key those two functions emit IS the public payload. That payload is
// pinned twice over: by the `ScheduleSettings` response schema in
// api-v1/schemas.ts, and by openapi/v1.json, which documents GET's `data` as
// exactly { division_id, config, tz, updated_at }.
//
// The INTERNAL settings object (`ScheduleSettingsOut`, what `loadSettings`
// returns) carries TWO zones one letter apart — `displayTz` (rendering) and
// `orgTz` (the governing clock, #397/#448). Renaming the internal display field
// is a good idea; renaming the PUBLIC key along with it is a breaking change
// that nothing else in this repo would catch — the pages read `.tz` off the
// same object and would simply follow the rename. This suite is the tripwire:
// it fails if either boundary function stops emitting `tz`, starts emitting an
// extra field, or stops putting the DISPLAY zone in it.
//
// Real Postgres required; skipped without DATABASE_URL (CI runs them).
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { ScheduleSettings } from "@/server/api-v1/schemas";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { getScheduleSettings, putScheduleSettings } from "../schedule";

const HAS_DB = !!process.env.DATABASE_URL;

/** Exactly what openapi/v1.json documents for this route's `data`. */
const WIRE_KEYS = ["config", "division_id", "tz", "updated_at"];

const DIVISION_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

const CONFIG = {
  startAt: "2026-08-01T09:00:00.000Z",
  matchMinutes: 30,
  gapMinutes: 0,
  courts: ["Court 1"],
  perEntrantMinRest: 0,
  blackouts: [],
  sessionWindows: [],
};

/** Org zone and division zone must DIFFER, or "tz carries the display zone"
 *  and "tz carries the governing zone" agree and the assertion is vacuous. */
const ORG_TZ = "Europe/London";
const DIVISION_TZ = "Europe/Madrid";

async function seedOrg(): Promise<AuthCtx> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, timezone)
    values (${"Wire Org " + suffix}, ${"wire-org-" + suffix}, ${ORG_TZ})
    returning id`;
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score', ${sql.json(DIVISION_CONFIG)}, true)
    on conflict do nothing`;
  return { orgId, via: "session", userId: null, role: "owner", keyId: null };
}

/** A division pinned to its own zone — the case where display and governing
 *  zones disagree, which is the whole reason the two fields exist. */
async function seedDivision(auth: AuthCtx): Promise<string> {
  const competition = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Wire Cup",
    visibility: "public",
    branding: {},
  });
  const division = await createDivision(auth, competition.id, {
    name: "Open",
    slug: "open",
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    eligibility: [],
  });
  await sql`
    insert into schedule_settings (division_id, config, tz, updated_at)
    values (${division.id}, ${sql.json(CONFIG as never)}, ${DIVISION_TZ}, now())
    on conflict (division_id) do update set tz = excluded.tz`;
  return division.id;
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("schedule-settings wire contract", () => {
  it("GET emits exactly { division_id, config, tz, updated_at }", async () => {
    const auth = await seedOrg();
    const divisionId = await seedDivision(auth);

    const wire = await getScheduleSettings(auth, divisionId);
    expect(Object.keys(wire).sort()).toEqual(WIRE_KEYS);
  });

  it("PUT emits the same key set — it must not leak the internal shape", async () => {
    const auth = await seedOrg();
    const divisionId = await seedDivision(auth);

    const wire = await putScheduleSettings(auth, divisionId, { config: CONFIG });
    expect(Object.keys(wire).sort()).toEqual(WIRE_KEYS);
  });

  it("`tz` carries the DISPLAY zone, not the governing org zone", async () => {
    const auth = await seedOrg();
    const divisionId = await seedDivision(auth);

    // The division overrides; the org is elsewhere. `tz` is the override.
    expect((await getScheduleSettings(auth, divisionId)).tz).toBe(DIVISION_TZ);
    expect((await putScheduleSettings(auth, divisionId, { config: CONFIG })).tz).toBe(DIVISION_TZ);
  });

  it("round-trips through the ScheduleSettings response schema unchanged", async () => {
    const auth = await seedOrg();
    const divisionId = await seedDivision(auth);

    // zod STRIPS unknown keys, so an extra field on the payload makes the
    // parsed object differ from the emitted one — this is what catches a new
    // undocumented field sneaking onto the wire.
    const wire = await getScheduleSettings(auth, divisionId);
    expect(ScheduleSettings.parse(wire)).toEqual(wire);

    const put = await putScheduleSettings(auth, divisionId, { config: CONFIG });
    expect(ScheduleSettings.parse(put)).toEqual(put);
  });
});
