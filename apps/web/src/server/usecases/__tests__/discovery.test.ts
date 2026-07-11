// PROMPT-19 acceptance (doc 15): opt-in/opt-out/visibility-drop/staff-block
// paths against public_discovery_v, the hard public-coupling, branding
// gating, quality floor, and the no-person-data guarantee of the view.
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { HttpError, PaymentRequiredError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition, patchCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { startDivision } from "../schedule";
import { discoveryList } from "../public";

const HAS_DB = !!process.env.DATABASE_URL;

const DIVISION_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

async function makeUser(name: string, verified = true): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`${name}-${randomUUID().slice(0, 8)}@test.local`}, ${name}, ${verified})
    returning id`;
  return id;
}

async function seedOrg(opts: { verifiedOwner?: boolean } = {}): Promise<{
  orgId: string;
  ownerId: string;
}> {
  const suffix = randomUUID().slice(0, 8);
  const ownerId = await makeUser("owner", opts.verifiedOwner ?? true);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"Disc Org " + suffix}, ${"disc-org-" + suffix}, ${ownerId}) returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${ownerId}, 'owner')`;
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score', ${sql.json(DIVISION_CONFIG)}, true)
    on conflict do nothing`;
  return { orgId, ownerId };
}

const asOwner = (orgId: string, userId: string): AuthCtx => ({
  orgId,
  via: "session",
  userId,
  role: "owner",
  keyId: null,
});

/** Public competition with a started division — passes the quality floor. */
async function publicRig(owner: AuthCtx) {
  const competition = await createCompetition(owner, {
    name: "Showcase Cup " + randomUUID().slice(0, 6),
    visibility: "public",
    branding: {},
  });
  const division = await createDivision(owner, competition.id, {
    name: "Open", sport_key: "generic", variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false }, eligibility: [],
  });
  await createEntrants(owner, division.id, ["A", "B", "C", "D"].map((n, i) => ({
    kind: "individual" as const, display_name: n, seed: i + 1, members: [],
  })));
  const [stage] = await createStages(owner, division.id, {
    seq: 1, kind: "league", name: "L", config: {},
  });
  await generateStageFixtures(owner, stage.id);
  await startDivision(owner, division.id);
  return { competition, division, stage };
}

async function inView(competitionId: string): Promise<boolean> {
  const rows = await sql`select id from public_discovery_v where id = ${competitionId}`;
  return rows.length > 0;
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("public discovery (doc 15, PROMPT-19)", () => {
  it("opt-in flow: toggle on → in view; toggle off → gone (audited both ways)", async () => {
    const { orgId, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    const { competition } = await publicRig(owner);

    expect(await inView(competition.id)).toBe(false); // public alone ≠ discoverable

    const on = await patchCompetition(owner, competition.id, { discoverable: true });
    expect(on.discoverable).toBe(true);
    expect(await inView(competition.id)).toBe(true);

    const off = await patchCompetition(owner, competition.id, { discoverable: false });
    expect(off.discoverable).toBe(false);
    expect(await inView(competition.id)).toBe(false);

    // Audited who/when (doc 15 §1): division-independent competition events.
    const audit = await sql<{ type: string; actor_id: string | null }[]>`
      select type, actor_id from competition_events
      where competition_id = ${competition.id} order by created_at, type`;
    expect(audit.map((a) => a.type)).toEqual(["discovery.opt_in", "discovery.opt_out"]);
    expect(audit[0].actor_id).toBe(ownerId);
  });

  it("create-time opt-in: wizard checkbox persists, audits, and 422s non-public", async () => {
    const { orgId, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);

    // Public + discoverable at create → persisted and audited (opt_in).
    const created = await createCompetition(owner, {
      name: "Born Showcased " + randomUUID().slice(0, 6),
      visibility: "public",
      discoverable: true,
      branding: {},
    });
    expect(created.discoverable).toBe(true);
    const audit = await sql<{ type: string; actor_id: string | null }[]>`
      select type, actor_id from competition_events
      where competition_id = ${created.id} and type like 'discovery.%'`;
    expect(audit).toHaveLength(1);
    expect(audit[0].type).toBe("discovery.opt_in");
    expect(audit[0].actor_id).toBe(ownerId);

    // Same hard coupling as PATCH: non-public + discoverable → 422.
    await expect(
      createCompetition(owner, {
        name: "Private Sneak " + randomUUID().slice(0, 6),
        visibility: "private",
        discoverable: true,
        branding: {},
      }),
    ).rejects.toMatchObject({ status: 422 });

    // Default stays off (unlisted — the org's one public-dashboard slot is
    // taken by the showcased competition above).
    const plain = await createCompetition(owner, {
      name: "Plain " + randomUUID().slice(0, 6),
      visibility: "unlisted",
      branding: {},
    });
    expect(plain.discoverable).toBe(false);
  });

  it("hard coupling: opt-in on a non-public competition → 422", async () => {
    const { orgId, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    const competition = await createCompetition(owner, {
      name: "Private " + randomUUID().slice(0, 6), visibility: "private", branding: {},
    });
    await expect(
      patchCompetition(owner, competition.id, { discoverable: true }),
    ).rejects.toThrowError(HttpError);
  });

  it("visibility drop auto-disables discoverable in the same tx", async () => {
    const { orgId, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    const { competition } = await publicRig(owner);
    await patchCompetition(owner, competition.id, { discoverable: true });

    const dropped = await patchCompetition(owner, competition.id, { visibility: "unlisted" });
    expect(dropped.discoverable).toBe(false);
    expect(await inView(competition.id)).toBe(false);

    const [{ n }] = await sql<{ n: string }[]>`
      select count(*) as n from competition_events
      where competition_id = ${competition.id} and type = 'discovery.opt_out'
        and payload->>'auto' = 'true'`;
    expect(Number(n)).toBe(1);
  });

  it("staff block and org suspension both remove the competition", async () => {
    const { orgId, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    const { competition } = await publicRig(owner);
    await patchCompetition(owner, competition.id, { discoverable: true });
    expect(await inView(competition.id)).toBe(true);

    await sql`update competitions set discovery_blocked = true where id = ${competition.id}`;
    expect(await inView(competition.id)).toBe(false);
    await sql`update competitions set discovery_blocked = false where id = ${competition.id}`;

    await sql`update organizations set status = 'suspended' where id = ${orgId}`;
    expect(await inView(competition.id)).toBe(false);
    await sql`update organizations set status = 'active' where id = ${orgId}`;
    expect(await inView(competition.id)).toBe(true);
  });

  it("quality floor: no started division / decided fixture → not listed; unverified owner → not listed", async () => {
    const { orgId, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    // Public + discoverable but nothing published/decided: an empty shell.
    const shell = await createCompetition(owner, {
      name: "Shell " + randomUUID().slice(0, 6), visibility: "public", branding: {},
    });
    await patchCompetition(owner, shell.id, { discoverable: true });
    expect(await inView(shell.id)).toBe(false);

    // Unverified owner org with a real rig still fails the floor.
    const unverified = await seedOrg({ verifiedOwner: false });
    const uOwner = asOwner(unverified.orgId, unverified.ownerId);
    const rig2 = await publicRig(uOwner);
    await patchCompetition(uOwner, rig2.competition.id, { discoverable: true });
    expect(await inView(rig2.competition.id)).toBe(false);
  });

  it("discovery.branding gates tagline/hero (402); city/country stay free", async () => {
    const { orgId, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    const { competition } = await publicRig(owner);

    await expect(
      patchCompetition(owner, competition.id, { discovery: { tagline: "The big one" } }),
    ).rejects.toThrowError(PaymentRequiredError);

    const row = await patchCompetition(owner, competition.id, {
      discoverable: true,
      discovery: { city: "Chennai", country: "India" },
    });
    expect((row.discovery as { city?: string }).city).toBe("Chennai");

    // Community org: tagline never rendered by the view even if forced in.
    await sql`update competitions
              set discovery = discovery || '{"tagline":"forced"}' where id = ${competition.id}`;
    const [entry] = await sql<{ tagline: string | null; city: string | null }[]>`
      select tagline, city from public_discovery_v where id = ${competition.id}`;
    expect(entry.tagline).toBeNull();
    expect(entry.city).toBe("Chennai");
  });

  it("view exposes no person data and discoveryList filters work", async () => {
    const { orgId, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    const { competition } = await publicRig(owner);
    await patchCompetition(owner, competition.id, { discoverable: true });

    const cols = await sql<{ column_name: string }[]>`
      select column_name from information_schema.columns
      where table_name = 'public_discovery_v'`;
    const names = cols.map((c) => c.column_name);
    // Consent matrix reuse (PROMPT-12): discovery adds ZERO person-data paths.
    for (const forbidden of ["full_name", "dob", "consent", "members", "photo"]) {
      expect(names).not.toContain(forbidden);
    }

    // Scope by name: the shared local test DB accumulates discoverable
    // competitions across runs and the page is capped at 24.
    const all = await discoveryList({ q: competition.name });
    expect(all.items.some((i) => i.id === competition.id)).toBe(true);
    const generic = await discoveryList({ sport: "generic", q: competition.name });
    expect(generic.items.some((i) => i.id === competition.id)).toBe(true);
    const nothing = await discoveryList({ sport: "no-such-sport" });
    expect(nothing.items.some((i) => i.id === competition.id)).toBe(false);
    const upcoming = await discoveryList({ status: "live" });
    expect(upcoming.items.some((i) => i.id === competition.id)).toBe(false);
  });

  it("empty state: home sections collapse to nothing", async () => {
    const { LiveNowStrip, ThisWeekSection } = await import("@/components/discovery-cards");
    expect(LiveNowStrip({ fixtures: [] })).toBeNull();
    expect(ThisWeekSection({ entries: [] })).toBeNull();
  });
});
