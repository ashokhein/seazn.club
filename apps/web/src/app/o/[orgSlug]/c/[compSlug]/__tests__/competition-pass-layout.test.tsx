// The competition layout's one job (v3/07 §3, task 16): answer "does this org
// hold an Event Pass for the competition in the URL?" from the slugs alone, and
// hand the answer to the client subtree.
//
// The load-bearing case is the STAFF GRANT. `competition_passes` (V271) is five
// columns and `stripe_payment_intent` is NULLABLE, so a pass granted by support
// carries no intent and is still fully active. Presence is about the ROW
// EXISTING; a layout that filtered on the intent would re-sell a pass the org
// already owns, which is the exact failure this state exists to prevent.
//
// Real Postgres required; skipped without DATABASE_URL. Seeds are run-unique.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";

import { sql } from "@/lib/db";
import { invalidateSlugCache } from "@/server/slug-resolve";
import { usePassActive } from "@/components/competition-pass-provider";
import CompetitionLayout from "../layout";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

function Probe() {
  return <span id="p">{`pass:${usePassActive()}`}</span>;
}

/** Render the layout exactly as Next would: `params` arrives as a PROMISE. */
async function renderLayout(orgSlug: string, compSlug: string): Promise<string> {
  const element = await CompetitionLayout({
    children: <Probe />,
    params: Promise.resolve({ orgSlug, compSlug }),
  });
  return renderToStaticMarkup(element);
}

interface Rig {
  orgId: string;
  orgSlug: string;
  compId: string;
  compSlug: string;
}

async function seed(): Promise<Rig> {
  const s = uniq();
  const orgSlug = "pass-layout-org-" + s;
  const compSlug = "pass-layout-cup-" + s;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Pass Layout Org " + s}, ${orgSlug})
    returning id`;
  await sql`insert into subscriptions (org_id, plan_key, status)
            values (${orgId}, 'community', 'active')
            on conflict (org_id) do update set plan_key = 'community', status = 'active'`;
  const [{ id: compId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, visibility)
    values (${orgId}, ${"Pass Layout Cup " + s}, ${compSlug}, 'unlisted') returning id`;
  // The slug resolvers cache-through Redis; a fresh row under a run-unique slug
  // can only collide with itself, but clear it so a re-run never reads a miss
  // cached by an earlier failure.
  await invalidateSlugCache("org", null, orgSlug);
  await invalidateSlugCache("competition", orgId, compSlug);
  return { orgId, orgSlug, compId, compSlug };
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("competition layout provides Event Pass state", () => {
  it("is false for a competition with no pass", async () => {
    const rig = await seed();
    expect(await renderLayout(rig.orgSlug, rig.compSlug)).toContain("pass:false");
  });

  it("is true once a purchased pass exists", async () => {
    const rig = await seed();
    // RED without the layout: no provider mounts, usePassActive() falls back to
    // its `false` default, and Task 17's gate re-sells a pass already bought.
    await sql`insert into competition_passes (competition_id, org_id, stripe_payment_intent)
              values (${rig.compId}, ${rig.orgId}, ${"pi_" + uniq()})`;
    expect(await renderLayout(rig.orgSlug, rig.compSlug)).toContain("pass:true");
  });

  it("is true for a STAFF-GRANTED pass, whose stripe_payment_intent is null", async () => {
    const rig = await seed();
    await sql`insert into competition_passes (competition_id, org_id)
              values (${rig.compId}, ${rig.orgId})`;
    const [row] = await sql<{ stripe_payment_intent: string | null }[]>`
      select stripe_payment_intent from competition_passes
      where competition_id = ${rig.compId}`;
    // Guards the premise: if this column ever stops being nullable the case
    // below is no longer testing what its name claims.
    expect(row.stripe_payment_intent).toBeNull();
    expect(await renderLayout(rig.orgSlug, rig.compSlug)).toContain("pass:true");
  });

  it("is false when the pass belongs to a SIBLING competition in the same org", async () => {
    // A pass unlocks ONE competition. Resolving org-wide is the bug this whole
    // branch keeps re-fixing, so the layout has to be competition-scoped.
    const rig = await seed();
    const s = uniq();
    const otherSlug = "pass-layout-other-" + s;
    const [{ id: otherId }] = await sql<{ id: string }[]>`
      insert into competitions (org_id, name, slug, visibility)
      values (${rig.orgId}, ${"Other Cup " + s}, ${otherSlug}, 'unlisted') returning id`;
    await invalidateSlugCache("competition", rig.orgId, otherSlug);
    await sql`insert into competition_passes (competition_id, org_id)
              values (${rig.compId}, ${rig.orgId})`;

    expect(await renderLayout(rig.orgSlug, rig.compSlug)).toContain("pass:true");
    expect(await renderLayout(rig.orgSlug, otherSlug)).toContain("pass:false");
    expect(otherId).not.toBe(rig.compId);
  });

  it("is false — and still renders children — for an unresolvable slug", async () => {
    // The child page owns the 404 / rename redirect. The layout must not
    // pre-empt it, and must not throw on the way past.
    const rig = await seed();
    const html = await renderLayout(rig.orgSlug, "no-such-competition-" + uniq());
    expect(html).toContain("pass:false");
    expect(html).toContain("<span");
  });
});
