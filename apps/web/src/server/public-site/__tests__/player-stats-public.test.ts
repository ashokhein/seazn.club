// PROMPT-65 — per-player stats on the public profile: getPublicPlayer reads
// player_stat_snapshots and labels metrics from the sport module's declared
// playerStats model. No stats.player gate on the profile block (locked
// decision: the leaderboard TABLE stays Pro; profile totals ride the existing
// consent + dashboard.player_profiles visibility). Real Postgres required.
import { describe, expect, it, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

// unstable_cache is a Next server-runtime API — passthrough under vitest.
vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
}));

import { sql } from "@/lib/db";
import { football } from "@seazn/engine/sports/football";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { createPerson } from "@/server/usecases/persons";
import { getPublicPlayer } from "../data";

const HAS_DB = !!process.env.DATABASE_URL;

const FOOTBALL_CONFIG = {
  halfMinutes: 45, halves: 2, extraTime: { enabled: false, halfMinutes: 15 },
  shootout: false, points: { win: 3, draw: 1, loss: 0 },
  awardScore: { goals: 3 }, fairPlay: true, abandonPolicy: "replay",
};

async function seed() {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Ps " + suffix}, ${"ps-" + suffix})
    returning id`;
  await sql`
    insert into subscriptions (org_id, plan_key, status) values (${orgId}, 'pro', 'active')
    on conflict (org_id) do update set plan_key = 'pro'`;
  await invalidateOrgEntitlements(orgId);
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('football', 'Football', '1.0.0',
            ${sql.json(football.positions as never)})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('football', 'std', 'Standard', ${sql.json(FOOTBALL_CONFIG)}, true)
    on conflict do nothing`;
  const auth: AuthCtx = { orgId, via: "session", userId: null, role: "owner", keyId: null };
  const comp = await createCompetition(auth, {
    name: "Ps Cup " + suffix, visibility: "public", branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open", slug: "open", sport_key: "football", variant_key: "std",
    config: FOOTBALL_CONFIG, eligibility: [],
  });
  const person = await createPerson(auth, {
    full_name: "Striker Nine",
    consent: { public_name: true },
  } as never);
  await createEntrants(auth, division.id, [
    {
      kind: "team", display_name: "Mexico",
      members: [{ person_id: person.id, squad_number: 9, is_captain: false, roles: [] }],
    } as never,
  ]);
  const [org] = await sql<{ slug: string }[]>`
    select slug from organizations where id = ${orgId}`;
  return { auth, orgId, orgSlug: org!.slug, compSlug: comp.slug, division, person };
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("getPublicPlayer stats (PROMPT-65)", () => {
  it("returns module-labelled totals from player_stat_snapshots; zeros filtered", async () => {
    const { orgSlug, compSlug, division, person } = await seed();
    await sql`
      insert into player_stat_snapshots (division_id, person_id, sport_key, stats, computed_through_seq)
      values (${division.id}, ${person.id}, 'football',
              ${sql.json({ goals: 2, assists: 1, yellow_cards: 0 })}, 10)`;
    const data = await getPublicPlayer(orgSlug, compSlug, person.id);
    expect(data).not.toBeNull();
    expect(data!.stats).toHaveLength(1);
    expect(data!.stats[0]).toMatchObject({ division_name: "Open", sport_key: "football" });
    const byKey = Object.fromEntries(data!.stats[0]!.metrics.map((m) => [m.key, m]));
    expect(byKey.goals).toMatchObject({ label: "Goals", value: 2 });
    expect(byKey.assists).toMatchObject({ label: "Assists", value: 1 });
    expect(byKey.yellow_cards).toBeUndefined(); // zero → filtered, no clutter
  });

  it("a player with no snapshots gets an empty stats list (no layout shift)", async () => {
    const { orgSlug, compSlug, person } = await seed();
    const data = await getPublicPlayer(orgSlug, compSlug, person.id);
    expect(data).not.toBeNull();
    expect(data!.stats).toEqual([]);
  });
});
