// Integration tests for PROMPT-26 (Jul3/06): DocModel assembly from live
// data, per-pitch breaks, empty-spot rows, branding gate, renderer bytes.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { patchFixture } from "../fixtures";
import {
  buildDivisionDocModel,
  buildCompetitionTimetable,
  buildOfficialsRotaDoc,
  buildAdmitTicketsDoc,
  buildMyRotaDoc,
} from "../exports";
import { docModelToPdf, docModelToXlsx } from "@/server/doc-render";

const HAS_DB = !!process.env.DATABASE_URL;

const GENERIC_CONFIG = {
  resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false,
};
const PRINTED = "2026-07-20T09:00:00.000Z";

async function seedOrg(plan: "community" | "pro" = "pro"): Promise<{ auth: AuthCtx }> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Exp " + suffix}, ${"exp-" + suffix})
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
  const comp = await createCompetition(auth, { name: "Print Cup", visibility: "private", branding: {} });
  const division = await createDivision(auth, comp.id, {
    name: "Open", slug: "open", sport_key: "generic", variant_key: "score",
    config: GENERIC_CONFIG, eligibility: [],
  });
  const entrants = await createEntrants(
    auth, division.id,
    ["A", "B", "Empty Spot 3", "D"].map((name, i) => ({
      kind: "individual" as const, display_name: name, seed: i + 1, members: [],
    })),
  );
  const [stage] = await createStages(auth, division.id, { seq: 1, kind: "league", name: "League", config: {} });
  const { fixtures } = await generateStageFixtures(auth, stage!.id);
  return { comp, division, stage: stage!, fixtures, entrants };
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("rich exports (Jul3/06)", () => {
  it("timetable model carries title + stage headings; renders to PDF and XLSX bytes", async () => {
    const { auth } = await seedOrg();
    const { division, fixtures } = await seedDivision(auth);
    await patchFixture(auth, fixtures[0]!.id, {
      scheduled_at: "2026-07-20T09:00:00.000Z", court_label: "Court 1",
    });
    const model = await buildDivisionDocModel(auth, division.id, "timetable", { printedAt: PRINTED });
    expect(model.title).toBe("Print Cup — Open");
    expect(model.meta.printedAt).toBe(PRINTED);
    expect(model.sections[0]!.subheading).toBe("League");

    const pdf = await docModelToPdf(model);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    const xlsx = await docModelToXlsx(model);
    expect(xlsx.length).toBeGreaterThan(500);
  });

  it("scoresheets pageBreaks=per_pitch: one stack per court, one break between them", async () => {
    const { auth } = await seedOrg();
    const { division, fixtures } = await seedDivision(auth);
    // Two courts, interleaved exactly as a real round robin comes back: R1 on
    // both courts, then R2 on both. This is the shape the old code got wrong —
    // it broke a page every time the court changed *in round order*, so it
    // produced three breaks here and grouped nothing.
    await patchFixture(auth, fixtures[0]!.id, { scheduled_at: "2026-07-20T09:00:00.000Z", court_label: "Court 1" });
    await patchFixture(auth, fixtures[1]!.id, { scheduled_at: "2026-07-20T09:00:00.000Z", court_label: "Court 2" });
    await patchFixture(auth, fixtures[2]!.id, { scheduled_at: "2026-07-20T09:30:00.000Z", court_label: "Court 1" });
    await patchFixture(auth, fixtures[3]!.id, { scheduled_at: "2026-07-20T09:30:00.000Z", court_label: "Court 2" });
    const model = await buildDivisionDocModel(auth, division.id, "scoresheet", {
      printedAt: PRINTED, pageBreaks: "per_pitch",
    });

    // seedDivision is a 4-entrant round robin (6 fixtures), so the two left
    // without a court form a third group that sorts last. Three groups → two
    // boundaries, never in front of the first sheet. The old code broke on
    // every court change in round order and produced far more.
    const breaks = model.sections.filter((s) => s.pageBreakBefore === true);
    expect(breaks).toHaveLength(2);
    expect(model.sections[0]!.pageBreakBefore).not.toBe(true);

    // Every Court 1 sheet precedes every Court 2 sheet, and unassigned sheets
    // come last — that is the point of the option: one pile per official.
    const courtOf = (sub?: string) =>
      sub?.includes("Court 1") ? 1 : sub?.includes("Court 2") ? 2 : 3;
    const order = model.sections.map((s) => courtOf(s.subheading));
    expect(order).toEqual([...order].sort((a, b) => a - b));

    // generic sport falls back to the result form with signatures
    expect(model.sections[0]!.signatures).toContain("Referee");
  });

  it("participants export keeps Empty-Spot rows; roster lists teams", async () => {
    const { auth } = await seedOrg();
    const { division } = await seedDivision(auth);
    const participants = await buildDivisionDocModel(auth, division.id, "participants", { printedAt: PRINTED });
    const flat = JSON.stringify(participants.sections);
    expect(flat).toContain("Empty Spot 3");
    const roster = await buildDivisionDocModel(auth, division.id, "roster", { printedAt: PRINTED });
    expect(roster.sections.map((s) => s.heading)).toContain("Empty Spot 3");
  });

  it("branding is Pro (`exports.branded`): Pro branded; community exports render plain (V285)", async () => {
    const { auth } = await seedOrg("pro");
    const { division, comp } = await seedDivision(auth);
    await sql`update competitions set branding = ${sql.json({ primary_color: "#123456", logo_path: "orgs/x/logo.png" } as never)}
              where id = ${comp.id}`;
    const branded = await buildDivisionDocModel(auth, division.id, "timetable", { printedAt: PRINTED });
    expect(branded.branding).toMatchObject({ colors: { primary: "#123456" }, logos: ["orgs/x/logo.png"] });
    expect(branded.branding?.orgName).toBeTruthy();

    // drop to a plan without exports.branded via override
    await sql`insert into org_entitlement_overrides (org_id, feature_key, bool_value)
              values (${auth.orgId}, 'exports.branded', false)
              on conflict (org_id, feature_key) do update set bool_value = false`;
    await invalidateOrgEntitlements(auth.orgId);
    const unbranded = await buildDivisionDocModel(auth, division.id, "timetable", { printedAt: PRINTED });
    expect(unbranded.branding).toBeUndefined();

    // Community can export now (V285) but plain — exports.branded stays Pro.
    const { auth: freeAuth } = await seedOrg("community");
    const { division: freeDiv } = await seedDivision(freeAuth);
    const freeModel = await buildDivisionDocModel(freeAuth, freeDiv.id, "timetable", { printedAt: PRINTED });
    expect(freeModel.branding).toBeUndefined();
  });

  it("brandingFor: Pro model carries orgName + tiered sponsors from the sponsors table", async () => {
    const { auth } = await seedOrg("pro");
    const { division, comp } = await seedDivision(auth);
    await sql`insert into sponsors (org_id, competition_id, name, tier, status, display_order)
              values (${auth.orgId}, ${comp.id}, 'Acme', 'title', 'active', 0)`;
    const model = await buildDivisionDocModel(auth, division.id, "timetable", { printedAt: PRINTED });
    expect(model.branding?.orgName).toBeTruthy();
    expect(model.branding?.sponsors).toContainEqual({ name: "Acme", tier: "title" });
  });

  it("competition-wide timetable groups per division", async () => {
    const { auth } = await seedOrg();
    const { comp } = await seedDivision(auth);
    const model = await buildCompetitionTimetable(auth, comp.id, { printedAt: PRINTED });
    expect(model.title).toBe("Print Cup");
    expect(model.pageBreaks).toBe("per_division");
    expect(model.sections.some((s) => s.heading === "Open")).toBe(true);
  });

  it("buildCompetitionTimetable carries branding for a Pro org", async () => {
    const { auth } = await seedOrg("pro");
    const { comp } = await seedDivision(auth);
    const model = await buildCompetitionTimetable(auth, comp.id, { printedAt: PRINTED });
    expect(model.branding?.orgName).toBeTruthy();
  });

  it("division timetable sets a description", async () => {
    const { auth } = await seedOrg("pro");
    const { division } = await seedDivision(auth);
    const model = await buildDivisionDocModel(auth, division.id, "timetable", { printedAt: PRINTED });
    expect(model.description).toMatch(/fixtures/i);
  });

  it("live-page QR (Task 16): public competition's timetable carries meta.liveUrl to /shared/...; private carries none", async () => {
    const { auth } = await seedOrg("pro");
    const { division, comp } = await seedDivision(auth);
    const [{ slug: orgSlug }] = await sql<{ slug: string }[]>`
      select slug from organizations where id = ${auth.orgId}`;

    // seedDivision creates the competition as visibility: "private" — its
    // /shared/... page 404s, so no QR belongs on it.
    const privateModel = await buildDivisionDocModel(auth, division.id, "timetable", {
      printedAt: PRINTED,
    });
    expect(privateModel.meta.liveUrl).toBeUndefined();

    // The origin is no longer threaded from the request: a QR is scanned by a
    // phone that has to reach the public site, so it comes from siteOrigin()
    // and visibility is the only thing that decides whether one is drawn.
    await sql`update competitions set visibility = 'public' where id = ${comp.id}`;
    const model = await buildDivisionDocModel(auth, division.id, "timetable", {
      printedAt: PRINTED,
    });
    expect(model.meta.liveUrl).toBe(
      `https://seazn.club/shared/${orgSlug}/${comp.slug}/${division.slug}`,
    );
  });

  it("officials rota (v12/Task 13): lists an official's duties with response", async () => {
    const { auth } = await seedOrg("pro");
    const { division, fixtures } = await seedDivision(auth);
    const [{ id: officialId }] = await sql<{ id: string }[]>`
      insert into officials (org_id, display_name) values (${auth.orgId}, 'Sam Ref')
      returning id`;
    await sql`
      insert into fixture_officials (fixture_id, official_id, role_key, response)
      values (${fixtures[0]!.id}, ${officialId}, 'referee', 'accepted')`;

    const model = await buildOfficialsRotaDoc(auth, division.id, { printedAt: PRINTED });
    expect(model.kind).toBe("officials_rota");
    const section = model.sections.find((s) => s.heading === "Sam Ref");
    expect(section).toBeTruthy();
    const rows = section!.table!.rows;
    expect(rows.some((r) => r.includes("referee") && r.includes("Accepted"))).toBe(true);
  });

  it("admit tickets (v12/Task 13): masked names + /r/[ref] QR URLs", async () => {
    const { auth } = await seedOrg("pro");
    const { division, comp } = await seedDivision(auth);
    await sql`update divisions set player_name_display = 'first_initial' where id = ${division.id}`;
    const suffix = randomUUID().slice(0, 8);
    const [{ ref_code }] = await sql<{ ref_code: string }[]>`
      insert into registrations
        (division_id, org_id, status, display_name, contact_email, access_token_hash, ref_code)
      values
        (${division.id}, ${auth.orgId}, 'confirmed', 'Jamie Doe', ${"jamie+" + suffix + "@example.com"},
         ${randomUUID()}, ${"TIX-" + suffix})
      returning ref_code`;

    const model = await buildAdmitTicketsDoc(auth, comp.id, { printedAt: PRINTED });
    expect(model.kind).toBe("admit_ticket");
    const ticket = model.sections[0]!.ticket!;
    expect(ticket.maskedName).toBeTruthy();
    expect(ticket.maskedName).not.toBe("Jamie Doe"); // youth-default division masks
    expect(ticket.qrUrl).toContain(`/r/${ref_code}`);
  });

  it("buildMyRotaDoc: SEAZN-neutral — no org branding", async () => {
    const model = await buildMyRotaDoc(randomUUID(), { printedAt: PRINTED });
    expect(model.kind).toBe("officials_rota");
    expect(model.branding).toBeUndefined();
  });

  it("Task 14: officials rota + admit tickets export plain for Community (V285), branded for Pro", async () => {
    const { auth: freeAuth } = await seedOrg("community");
    const { division: freeDiv, comp: freeComp } = await seedDivision(freeAuth);
    const freeRota = await buildOfficialsRotaDoc(freeAuth, freeDiv.id, { printedAt: PRINTED });
    expect(freeRota.branding).toBeUndefined();
    const freeTickets = await buildAdmitTicketsDoc(freeAuth, freeComp.id, { printedAt: PRINTED });
    expect(freeTickets.branding).toBeUndefined();

    const { auth: proAuth } = await seedOrg("pro");
    const { division: proDiv, comp: proComp } = await seedDivision(proAuth);
    await expect(
      buildOfficialsRotaDoc(proAuth, proDiv.id, { printedAt: PRINTED }),
    ).resolves.toBeTruthy();
    await expect(
      buildAdmitTicketsDoc(proAuth, proComp.id, { printedAt: PRINTED }),
    ).resolves.toBeTruthy();
  });

  it("Task 14: buildMyRotaDoc is scoped to the caller — never leaks another official's assignments", async () => {
    const { auth } = await seedOrg("pro");
    const { fixtures } = await seedDivision(auth);
    await patchFixture(auth, fixtures[0]!.id, {
      scheduled_at: new Date(Date.now() + 7 * 86_400_000).toISOString(), court_label: "Court 1",
    });
    await patchFixture(auth, fixtures[1]!.id, {
      scheduled_at: new Date(Date.now() + 8 * 86_400_000).toISOString(), court_label: "Court 2",
    });

    async function makeLinkedOfficial(name: string, fixtureId: string) {
      const suffix = randomUUID().slice(0, 8);
      const [{ id: userId }] = await sql<{ id: string }[]>`
        insert into users (email, display_name, email_verified)
        values (${`${name}-${suffix}@test.local`}, ${name}, true)
        returning id`;
      const [{ id: personId }] = await sql<{ id: string }[]>`
        insert into persons (org_id, full_name, user_id)
        values (${auth.orgId}, ${name}, ${userId}) returning id`;
      const [{ id: officialId }] = await sql<{ id: string }[]>`
        insert into officials (org_id, person_id, display_name)
        values (${auth.orgId}, ${personId}, ${name}) returning id`;
      await sql`
        insert into fixture_officials (org_id, fixture_id, official_id, role_key, response)
        values (${auth.orgId}, ${fixtureId}, ${officialId}, 'referee', 'accepted')`;
      return { userId, officialId };
    }

    const a = await makeLinkedOfficial("Rota User A", fixtures[0]!.id); // Court 1
    await makeLinkedOfficial("Rota User B", fixtures[1]!.id); // Court 2

    const model = await buildMyRotaDoc(a.userId, { printedAt: PRINTED });
    const flat = JSON.stringify(model.sections);
    // A's own duty (Court 1) shows; B's fixture (Court 2) never leaks in.
    expect(flat).toContain("Court 1");
    expect(flat).not.toContain("Court 2");
  });
});
