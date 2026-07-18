// Integration tests for PROMPT-24 (Jul3/04): bulk shift (undoable), wait
// report, AI constraints resolution, Pro gates, flexible mode. Real Postgres
// required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision, patchDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { patchFixture } from "../fixtures";
import { putScheduleSettings, autoSchedule } from "../schedule";
import { PutScheduleSettings } from "@/server/api-v1/schemas";
import { undoDivision } from "../history";
import {
  shiftDivisionSchedule,
  divisionScheduleReport,
  aiConstraintsForDivision,
} from "../schedule-plus";

const HAS_DB = !!process.env.DATABASE_URL;

const GENERIC_CONFIG = {
  resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false,
};

async function seedOrg(
  plan: "community" | "pro" | "pro_plus" = "pro",
): Promise<{ auth: AuthCtx }> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"C2 " + suffix}, ${"c2-" + suffix})
    returning id`;
  if (plan !== "community") {
    await sql`
      insert into subscriptions (org_id, plan_key, status)
      values (${orgId}, ${plan}, 'active')
      on conflict (org_id) do update set plan_key = ${plan}`;
  }
  await invalidateOrgEntitlements(orgId);
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score', ${sql.json(GENERIC_CONFIG)}, true)
    on conflict do nothing`;
  return { auth: { orgId, via: "session", userId: null, role: "owner", keyId: null } };
}

async function seedDivision(auth: AuthCtx) {
  const comp = await createCompetition(auth, { name: "C2 Cup", visibility: "private", branding: {} });
  const division = await createDivision(auth, comp.id, {
    name: "Open", slug: "open", sport_key: "generic", variant_key: "score",
    config: GENERIC_CONFIG, eligibility: [],
  });
  const entrants = await createEntrants(
    auth, division.id,
    ["A", "B", "C", "D"].map((name, i) => ({
      kind: "individual" as const, display_name: name, seed: i + 1, members: [],
    })),
  );
  const [stage] = await createStages(auth, division.id, { seq: 1, kind: "league", name: "L", config: {} });
  const { fixtures } = await generateStageFixtures(auth, stage!.id);
  return { division, stage: stage!, fixtures, entrants };
}

const at = (m: number) => new Date(Date.UTC(2026, 6, 20, 9, m, 0)).toISOString();

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("scheduling constraints v2 (Jul3/04)", () => {
  it("bulk-shift +15m moves all in scope, skips locked, and is undoable (PROMPT-23)", async () => {
    const { auth } = await seedOrg();
    const { division, fixtures } = await seedDivision(auth);
    await patchFixture(auth, fixtures[0]!.id, { scheduled_at: at(0), court_label: "C1" });
    await patchFixture(auth, fixtures[1]!.id, { scheduled_at: at(30), court_label: "C1" });
    await patchFixture(auth, fixtures[1]!.id, { schedule_locked: true });

    const result = await shiftDivisionSchedule(auth, {
      division_id: division.id, scope: { excludeLocked: true }, delta_minutes: 15,
    });
    expect(result.shifted).toBe(1);
    expect(result.skipped.locked).toBe(1);
    const [moved] = await sql<{ scheduled_at: string }[]>`
      select scheduled_at::text as scheduled_at from fixtures where id = ${fixtures[0]!.id}`;
    expect(new Date(moved!.scheduled_at).toISOString()).toBe(at(15));

    await undoDivision(auth, division.id);
    const [back] = await sql<{ scheduled_at: string }[]>`
      select scheduled_at::text as scheduled_at from fixtures where id = ${fixtures[0]!.id}`;
    expect(new Date(back!.scheduled_at).toISOString()).toBe(at(0));
  });

  it("wait report surfaces the worst gap", async () => {
    const { auth } = await seedOrg();
    const { division, fixtures, entrants } = await seedDivision(auth);
    // A plays at 9:00 and 14:00 → 270-minute wait (30-minute matches)
    const aGames = fixtures.filter(
      (f: { home_entrant_id: string | null; away_entrant_id: string | null }) =>
        f.home_entrant_id === entrants[0]!.id || f.away_entrant_id === entrants[0]!.id,
    );
    await patchFixture(auth, aGames[0]!.id, { scheduled_at: at(0), court_label: "C1" });
    await patchFixture(auth, aGames[1]!.id, { scheduled_at: at(300), court_label: "C1" });
    const report = await divisionScheduleReport(auth, division.id);
    expect(report.worst[0]).toMatchObject({ display_name: "A", maxGapMinutes: 270 });
  });

  it("AI constraints resolve names to ids; unparseable output is refused; Community 402", async () => {
    // V290: scheduling.ai moved Pro → Pro Plus (spec D4).
    const { auth } = await seedOrg("pro_plus");
    const { division } = await seedDivision(auth);
    const out = await aiConstraintsForDivision(
      auth, division.id,
      "no player plays two teams at once, one break between games, A not before 09:30",
      async () => ({
        crossPersonClash: "hard",
        noBackToBack: true,
        startWindows: [
          { targetKind: "entrant", targetName: "a", notBefore: "09:30" },
          { targetKind: "pool", targetName: "Nope", notBefore: "10:00" },
        ],
      }),
    );
    expect(out.constraints.crossPersonClash).toBe("hard");
    expect(out.constraints.noBackToBack).toBe(true);
    expect(out.constraints.startWindows).toHaveLength(1);
    expect(out.constraints.startWindows[0]!.notBefore).toContain("09:30");
    expect(out.unresolved).toEqual([{ kind: "pool", name: "Nope" }]);

    await expect(
      aiConstraintsForDivision(auth, division.id, "gibberish", async () => "not an object"),
    ).rejects.toThrow();

    const { auth: freeAuth } = await seedOrg("community");
    const { division: freeDiv } = await seedDivision(freeAuth);
    await expect(
      aiConstraintsForDivision(freeAuth, freeDiv.id, "anything", async () => ({})),
    ).rejects.toMatchObject({ featureKey: "scheduling.ai" });
  });

  it("Pro AI scheduling is capped at 5 generations per division; the 6th is 402 (owner 2026-07-18)", async () => {
    const { auth } = await seedOrg("pro");
    const { division } = await seedDivision(auth);
    // Five generations succeed and each records a run against the per-division cap.
    for (let i = 0; i < 5; i++) {
      const out = await aiConstraintsForDivision(
        auth, division.id, "matches start at 9am", async () => ({}),
      );
      expect(out.constraints).toBeTruthy();
    }
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from competition_events
      where type = 'schedule.ai_generated' and payload->>'division_id' = ${division.id}`;
    expect(n).toBe(5);
    // The sixth breaches the cap — 402 with the runs-per-division key.
    await expect(
      aiConstraintsForDivision(auth, division.id, "anything", async () => ({})),
    ).rejects.toMatchObject({
      status: 402,
      featureKey: "scheduling.ai.runs_per_division.max",
    });
    // A blocked run is not recorded (still five).
    const [{ n: after }] = await sql<{ n: number }[]>`
      select count(*)::int as n from competition_events
      where type = 'schedule.ai_generated' and payload->>'division_id' = ${division.id}`;
    expect(after).toBe(5);
  });

  it("Pro Plus AI scheduling is unlimited (null limit) even past five prior runs", async () => {
    const { auth } = await seedOrg("pro_plus");
    const { division } = await seedDivision(auth);
    // Seed six prior runs directly — more than the Pro cap.
    for (let i = 0; i < 6; i++) {
      await sql`
        insert into competition_events (competition_id, org_id, type, payload)
        values (${division.competition_id}, ${auth.orgId}, 'schedule.ai_generated',
                ${sql.json({ division_id: division.id })})`;
    }
    const out = await aiConstraintsForDivision(
      auth, division.id, "matches start at 9am", async () => ({}),
    );
    expect(out.constraints).toBeTruthy();
  });

  it("constraint fields on schedule-settings are Pro; flexible mode blocks auto-scheduling", async () => {
    const { auth: freeAuth } = await seedOrg("community");
    const { division: freeDiv } = await seedDivision(freeAuth);
    await expect(
      putScheduleSettings(
        freeAuth,
        freeDiv.id,
        PutScheduleSettings.parse({
          config: { courts: ["Court 1"], constraints: { crossPersonClash: "hard" } },
          tz: "UTC",
        }),
      ),
    ).rejects.toMatchObject({ featureKey: "scheduling.constraints" });

    const { auth } = await seedOrg();
    const { division, stage } = await seedDivision(auth);
    await patchDivision(auth, division.id, { scheduling_mode: "flexible" });
    await expect(autoSchedule(auth, stage.id, true)).rejects.toThrow(/flexible scheduling/);
  });
});
