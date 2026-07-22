// Funnel draft lifecycle (v3/07 §6): single-use consumption, expiry, and
// createFromDraft building real structure through the standard use-cases.
// Real Postgres required — skipped without DATABASE_URL (test-infra recipe).
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { getLimit } from "@/lib/entitlements";
import {
  consumeFunnelDraft,
  createFromDraft,
  createFunnelDraft,
  type FunnelPayload,
} from "@/lib/funnel";

const HAS_DB = !!process.env.DATABASE_URL;

const PAYLOAD: FunnelPayload = {
  name: "Spring Smash",
  sport: "Badminton",
  entrants: 16,
};

async function seedUser(): Promise<string> {
  const email = `funnel-${randomUUID().slice(0, 8)}@example.com`;
  const [u] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${email}, 'Funnel Tester', true)
    returning id`;
  return u.id;
}

async function seedGenericSport(): Promise<void> {
  await sql`
    insert into sports (key, name, module_version, position_catalog) values
      ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system) values
      ('generic', 'score', 'Score', ${sql.json({
        resultMode: "score",
        allowDraws: true,
        points: { w: 3, d: 1, l: 0 },
        progressScore: false,
      })}, true)
    on conflict do nothing`;
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("funnel drafts (v3/07 §6)", () => {
  it("consumes a token exactly once", async () => {
    const { token } = await createFunnelDraft("once@example.com", PAYLOAD);
    const first = await consumeFunnelDraft(token);
    expect(first?.email).toBe("once@example.com");
    expect(first?.payload.name).toBe("Spring Smash");
    expect(await consumeFunnelDraft(token)).toBeNull();
  });

  it("rejects expired and unknown tokens", async () => {
    const { token } = await createFunnelDraft("late@example.com", PAYLOAD);
    await sql`update funnel_drafts set expires_at = now() - interval '1 minute'
      where token = ${token}`;
    expect(await consumeFunnelDraft(token)).toBeNull();
    expect(await consumeFunnelDraft("no-such-token-here")).toBeNull();
  });

  it("createFromDraft provisions org + competition + division and lands inside", async () => {
    await seedGenericSport();
    const userId = await seedUser();
    const { token } = await createFunnelDraft("builder@example.com", PAYLOAD);
    const draft = (await consumeFunnelDraft(token))!;

    const { redirect } = await createFromDraft(userId, draft);
    // Lands on the new division's entrants tab under the new org/comp slugs.
    expect(redirect).toMatch(/^\/o\/[^/]+\/c\/spring-smash[^/]*\/d\/[^/?]+\?tab=entrants$/);

    // Badminton has been a registered module since the v6 sports wave, so
    // the draft's sport name resolves to the real module (not the generic
    // fallback this test predates).
    const [div] = await sql<{ sport_key: string; name: string }[]>`
      select d.sport_key, d.name from divisions d
      join competitions c on c.id = d.competition_id
      join organizations o on o.id = c.org_id
      where o.created_by = ${userId}`;
    expect(div.sport_key).toBe("badminton");
    expect(div.name).toBe("Badminton");

    // A second claimed draft reuses the existing org (org-if-none rule).
    const second = await createFunnelDraft("builder@example.com", {
      ...PAYLOAD,
      name: "Autumn Open",
    });
    const draft2 = (await consumeFunnelDraft(second.token))!;
    // Fill the org to the free plan's active-competition cap first. V311 (D22)
    // raised that cap 1 → 5, so the funnel's first competition no longer
    // exhausts it on its own; the padding is derived from the live limit rather
    // than a literal so the next matrix move doesn't quietly turn this
    // over-quota assertion into a no-op.
    const [{ org_id: orgId }] = await sql<{ org_id: string }[]>`
      select id as org_id from organizations where created_by = ${userId}`;
    const limit = (await getLimit(orgId, "competitions.max_active"))!;
    const [{ active }] = await sql<{ active: number }[]>`
      select count(*)::int as active from competitions
      where org_id = ${orgId} and status in ('draft', 'published', 'live')`;
    const pad = randomUUID().slice(0, 8);
    for (let i = active; i < limit; i++) {
      await sql`
        insert into competitions (org_id, name, slug, status)
        values (${orgId}, ${`Filler ${i} ${pad}`}, ${`filler-${i}-${pad}`}, 'published')`;
    }
    // At the cap now — the second create must 402 rather than silently piling
    // on (the claim route surfaces this).
    await expect(createFromDraft(userId, draft2)).rejects.toMatchObject({
      status: 402,
      featureKey: "competitions.max_active",
    });
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from organizations where created_by = ${userId}`;
    expect(n).toBe(1);
  });

  // Unknown-sport fallback: GenericCfg now defaults points/progressScore, so
  // a partial preset (engine variants or a stale synced sport_variants row)
  // parses instead of throwing CONFIG_INVALID at createDivision. Guards the
  // /start funnel's generic fallback end to end.
  it("unknown sport falls back to the generic module", async () => {
    await seedGenericSport();
    const userId = await seedUser();
    const { token } = await createFunnelDraft("builder@example.com", {
      ...PAYLOAD,
      name: "Fallback Cup",
      sport: "Quidditch",
    });
    const draft = (await consumeFunnelDraft(token))!;
    await createFromDraft(userId, draft);
    const [div] = await sql<{ sport_key: string }[]>`
      select d.sport_key from divisions d
      join competitions c on c.id = d.competition_id
      join organizations o on o.id = c.org_id
      where o.created_by = ${userId}`;
    expect(div.sport_key).toBe("generic");
  });
});
