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
import { buildDivisionDocModel, buildCompetitionTimetable } from "../exports";
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

  it("scoresheets pageBreaks=per_pitch: each court starts a new page", async () => {
    const { auth } = await seedOrg();
    const { division, fixtures } = await seedDivision(auth);
    await patchFixture(auth, fixtures[0]!.id, { scheduled_at: "2026-07-20T09:00:00.000Z", court_label: "Court 1" });
    await patchFixture(auth, fixtures[1]!.id, { scheduled_at: "2026-07-20T09:30:00.000Z", court_label: "Court 2" });
    const model = await buildDivisionDocModel(auth, division.id, "scoresheet", {
      printedAt: PRINTED, pageBreaks: "per_pitch",
    });
    expect(model.sections.length).toBeGreaterThanOrEqual(2);
    expect(model.sections.some((s) => s.pageBreakBefore === true)).toBe(true);
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

  it("branding is Pro (`exports.branded`): non-Pro model has no branding block; exports gate 402s Community", async () => {
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

    const { auth: freeAuth } = await seedOrg("community");
    const { division: freeDiv } = await seedDivision(freeAuth);
    await expect(
      buildDivisionDocModel(freeAuth, freeDiv.id, "timetable", { printedAt: PRINTED }),
    ).rejects.toMatchObject({ featureKey: "exports" });
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
});
