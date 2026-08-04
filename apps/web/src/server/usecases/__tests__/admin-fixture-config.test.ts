// THE ESCAPE HATCH from the V347 config snapshot.
//
// A snapshot with no way out converts one class of unrecoverable state into
// another: an organiser who genuinely set the wrong config before scoring
// started would be frozen into it for the life of the fixture, with the fix
// (edit the division) silently having no effect. So staff can re-freeze a
// fixture from live config — audited, and only while the fixture is REOPENED,
// because rewriting the cfg under a finalized result is the very thing the
// snapshot exists to prevent.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { appendEvent, rebuildState } from "@/server/engine-db";
import { fixtureConfigPanel, resnapshotFixtureConfig } from "../admin-fixture-config";
import { HttpError } from "@/lib/http";

const HAS_DB = !!process.env.DATABASE_URL;

const CFG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
} as const;

interface Seed {
  orgId: string;
  actorId: string;
  divisionId: string;
  fixtureId: string;
  home: string;
  away: string;
}

async function seed(): Promise<Seed> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: actorId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, is_staff, staff_role)
    values (${`staff-${suffix}@example.test`}, 'Staff', true, 'superadmin')
    returning id`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Org " + suffix}, ${"org-" + suffix})
    returning id`;
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  const [{ id: competitionId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, visibility)
    values (${orgId}, ${"Comp " + suffix}, ${"comp-" + suffix}, 'private')
    returning id`;
  const [{ id: divisionId }] = await sql<{ id: string }[]>`
    insert into divisions (competition_id, name, slug, sport_key, variant_key, config, module_version)
    values (${competitionId}, 'Div', ${"div-" + suffix}, 'generic', 'score',
            ${sql.json(CFG)}, '1.0.0')
    returning id`;
  const [{ id: stageId }] = await sql<{ id: string }[]>`
    insert into stages (division_id, seq, kind, name, config)
    values (${divisionId}, 1, 'league', 'Stage', ${sql.json({})})
    returning id`;
  const [{ id: home }] = await sql<{ id: string }[]>`
    insert into entrants (division_id, kind, display_name, seed) values (${divisionId}, 'individual', 'Home', 1)
    returning id`;
  const [{ id: away }] = await sql<{ id: string }[]>`
    insert into entrants (division_id, kind, display_name, seed) values (${divisionId}, 'individual', 'Away', 2)
    returning id`;
  const [{ id: fixtureId }] = await sql<{ id: string }[]>`
    insert into fixtures (stage_id, division_id, round_no, seq_in_round, home_entrant_id, away_entrant_id)
    values (${stageId}, ${divisionId}, 1, 1, ${home}, ${away})
    returning id`;
  return { orgId, actorId, divisionId, fixtureId, home, away };
}

async function auditRows(fixtureId: string) {
  return sql<{ action: string; target_type: string; detail: Record<string, unknown> }[]>`
    select action, target_type, detail from staff_audit_log
    where target_id = ${fixtureId} order by created_at`;
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("admin fixture config snapshot", () => {
  it("reports the frozen cfg beside the live one so staff can see the divergence", async () => {
    const s = await seed();
    await appendEvent(s.orgId, s.fixtureId, 0, { type: "core.start", payload: {} });
    await sql`update divisions set config = ${sql.json({ ...CFG, allowDraws: false })} where id = ${s.divisionId}`;

    const panel = await fixtureConfigPanel(s.fixtureId);
    expect(panel).not.toBeNull();
    expect(panel!.snapshot).toEqual(CFG);
    expect(panel!.live).toEqual({ ...CFG, allowDraws: false });
    // The whole reason staff open this page: the two disagree.
    expect(panel!.diverged).toBe(true);
    expect(panel!.canResnapshot).toBe(true);
  });

  it("re-freezes a reopened fixture from live config, and the read follows", async () => {
    const s = await seed();
    await appendEvent(s.orgId, s.fixtureId, 0, { type: "core.start", payload: {} });
    await appendEvent(s.orgId, s.fixtureId, 1, {
      type: "generic.result",
      payload: { p1Score: 1, p2Score: 1 },
    });
    expect((await rebuildState(s.orgId, s.fixtureId))?.outcome).toEqual({ kind: "draw" });

    // The organiser meant a different points table all along. Fix the division,
    // then re-snapshot so this fixture picks the correction up.
    const corrected = { ...CFG, points: { w: 2, d: 1, l: 0 } };
    await sql`update divisions set config = ${sql.json(corrected)} where id = ${s.divisionId}`;
    await resnapshotFixtureConfig(s.actorId, s.fixtureId, "organiser set the points table wrong");

    const panel = await fixtureConfigPanel(s.fixtureId);
    expect(panel!.snapshot).toEqual(corrected);
    expect(panel!.diverged).toBe(false);
    // …and the fixture still reads. A hatch that leaves it unreadable is not a
    // hatch.
    const rebuilt = await rebuildState(s.orgId, s.fixtureId);
    expect(rebuilt?.outcome).toEqual({ kind: "draw" });
  });

  it("refuses a re-snapshot whose live config cannot read the recorded events", async () => {
    // The hatch must not become a one-click way to reproduce the exact bug it
    // exists to escape, on a fixture staff were trying to rescue. `allowDraws:
    // false` cannot read a recorded 1-1 draw.
    const s = await seed();
    await appendEvent(s.orgId, s.fixtureId, 0, { type: "core.start", payload: {} });
    await appendEvent(s.orgId, s.fixtureId, 1, {
      type: "generic.result",
      payload: { p1Score: 1, p2Score: 1 },
    });
    await sql`update divisions set config = ${sql.json({ ...CFG, allowDraws: false })} where id = ${s.divisionId}`;

    await expect(
      resnapshotFixtureConfig(s.actorId, s.fixtureId, "make it win_loss"),
    ).rejects.toThrow(/cannot read this fixture/i);

    // The refusal rolled BOTH writes back.
    const panel = await fixtureConfigPanel(s.fixtureId);
    expect(panel!.snapshot).toEqual(CFG);
    expect(await auditRows(s.fixtureId)).toHaveLength(0);
    expect((await rebuildState(s.orgId, s.fixtureId))?.outcome).toEqual({ kind: "draw" });
  });

  it("writes one audit row carrying the reason and both configs", async () => {
    const s = await seed();
    await appendEvent(s.orgId, s.fixtureId, 0, { type: "core.start", payload: {} });
    await sql`update divisions set config = ${sql.json({ ...CFG, allowDraws: false })} where id = ${s.divisionId}`;
    await resnapshotFixtureConfig(s.actorId, s.fixtureId, "ticket 4412");

    const rows = await auditRows(s.fixtureId);
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("fixture_config_resnapshot");
    expect(rows[0].target_type).toBe("fixture");
    expect(rows[0].detail.reason).toBe("ticket 4412");
    // Before AND after: the audit row has to be enough on its own to say what
    // the fixture used to fold against, because nothing else keeps the old one.
    expect(rows[0].detail.before).toEqual(CFG);
    expect(rows[0].detail.after).toEqual({ ...CFG, allowDraws: false });
  });

  it("refuses a finalized fixture — reopen it first", async () => {
    const s = await seed();
    await appendEvent(s.orgId, s.fixtureId, 0, { type: "core.start", payload: {} });
    await sql`update fixtures set status = 'finalized' where id = ${s.fixtureId}`;

    await expect(
      resnapshotFixtureConfig(s.actorId, s.fixtureId, "should not happen"),
    ).rejects.toBeInstanceOf(HttpError);
    // Refusal leaves NOTHING behind — not the snapshot, not an audit row that
    // would read as though staff had done something.
    const panel = await fixtureConfigPanel(s.fixtureId);
    expect(panel!.snapshot).toEqual(CFG);
    expect(panel!.canResnapshot).toBe(false);
    expect(await auditRows(s.fixtureId)).toHaveLength(0);
  });

  it("refuses a cancelled fixture on the same locked set the ledger guards on", async () => {
    const s = await seed();
    await appendEvent(s.orgId, s.fixtureId, 0, { type: "core.start", payload: {} });
    await sql`update fixtures set status = 'cancelled' where id = ${s.fixtureId}`;
    await expect(resnapshotFixtureConfig(s.actorId, s.fixtureId, "no")).rejects.toBeInstanceOf(
      HttpError,
    );
  });

  it("refuses an unscored fixture: there is nothing frozen to correct", async () => {
    const s = await seed();
    const panel = await fixtureConfigPanel(s.fixtureId);
    expect(panel!.snapshot).toBeNull();
    expect(panel!.canResnapshot).toBe(false);
    await expect(resnapshotFixtureConfig(s.actorId, s.fixtureId, "nothing here")).rejects.toThrow(
      /no config snapshot/i,
    );
  });

  it("demands a reason", async () => {
    const s = await seed();
    await appendEvent(s.orgId, s.fixtureId, 0, { type: "core.start", payload: {} });
    await expect(resnapshotFixtureConfig(s.actorId, s.fixtureId, "   ")).rejects.toBeInstanceOf(
      HttpError,
    );
  });

  it("returns null for a fixture that does not exist", async () => {
    expect(await fixtureConfigPanel(randomUUID())).toBeNull();
  });
});
