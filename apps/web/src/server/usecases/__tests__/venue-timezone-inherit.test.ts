// V305 — the scheduling timezone moved to the ORGANISATION and divisions
// inherit it. Two things must hold at the DB boundary:
//   1. a division with no stored tz reports the org's zone;
//   2. a division that already stores its own tz keeps it, forever, even
//      though nothing in the console can set (or resend) one any more.
// (2) is the dangerous one: divisions created before V305 hold real zones and
// a silent reset would shift their published timetables.
// Real Postgres required; skipped without DATABASE_URL (CI runs them).
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { getScheduleSettings, putScheduleSettings } from "../schedule";

const HAS_DB = !!process.env.DATABASE_URL;

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

async function seedOrg(timezone: string | null): Promise<AuthCtx> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, timezone)
    values (${"TZ Org " + suffix}, ${"tz-org-" + suffix}, ${timezone})
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

async function seedDivision(auth: AuthCtx): Promise<string> {
  const competition = await createCompetition(auth, {
    name: "TZ Cup",
    visibility: "public",
    branding: {},
  });
  const division = await createDivision(auth, competition.id, {
    name: "Open",
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    eligibility: [],
  });
  return division.id;
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("venue timezone inheritance (V305)", () => {
  it("inherits the org timezone when the division stores none", async () => {
    const auth = await seedOrg("Europe/Madrid");
    const divisionId = await seedDivision(auth);

    // No settings row at all.
    expect((await getScheduleSettings(auth, divisionId)).tz).toBe("Europe/Madrid");

    // …and still after a settings save, which never sends tz.
    const saved = await putScheduleSettings(auth, divisionId, { config: CONFIG });
    expect(saved.tz).toBe("Europe/Madrid");
    const [row] = await sql<{ tz: string | null }[]>`
      select tz from schedule_settings where division_id = ${divisionId}`;
    expect(row.tz).toBeNull(); // inheriting, not stamped
  });

  it("keeps a division's pre-existing tz through a save that omits tz", async () => {
    const auth = await seedOrg("Europe/Madrid");
    const divisionId = await seedDivision(auth);

    // Pin the division the way a pre-V305 division would have been.
    await putScheduleSettings(auth, divisionId, { config: CONFIG, tz: "Asia/Kolkata" });
    expect((await getScheduleSettings(auth, divisionId)).tz).toBe("Asia/Kolkata");

    // The console's save shape: config only, no tz key.
    const saved = await putScheduleSettings(auth, divisionId, {
      config: { ...CONFIG, matchMinutes: 45 },
    });
    expect(saved.config.matchMinutes).toBe(45);
    expect(saved.tz).toBe("Asia/Kolkata"); // NOT reset to the org's zone
  });

  it("clears back to inheriting when tz is explicitly null", async () => {
    const auth = await seedOrg("Europe/Madrid");
    const divisionId = await seedDivision(auth);
    await putScheduleSettings(auth, divisionId, { config: CONFIG, tz: "Asia/Kolkata" });
    const cleared = await putScheduleSettings(auth, divisionId, { config: CONFIG, tz: null });
    expect(cleared.tz).toBe("Europe/Madrid");
  });

  it("falls back to UTC when neither the division nor the org has a zone", async () => {
    const auth = await seedOrg(null);
    const divisionId = await seedDivision(auth);
    expect((await getScheduleSettings(auth, divisionId)).tz).toBe("UTC");
  });
});
