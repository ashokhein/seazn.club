// Phase 2 pass-scoping sweep — the sponsors tab's two Event Pass keys.
//
// `sponsors.tiers` and `sponsors.monetize` are lifted by the Event Pass
// (community=false, event_pass=true), but the settings page resolved both
// ORG-WIDE. lib/entitlements.ts only consults competition_passes when a
// competition is in scope, so a community org that bought a pass was shown the
// upsell for two features it had already paid for — the tier picker and the
// package composer never appeared, on any competition.
//
// This tab is genuinely ORG-LEVEL: the competition list beside it is a PICKER,
// not a scope, so there is no single competition to thread. The right question
// for an affordance is therefore "is this reachable ANYWHERE?" — answered by
// `hasFeatureOnAnyPass`. Enforcement stays per-competition in
// usecases/sponsors.ts (requireFeature(..., competitionId)), which is what
// keeps the widened affordance honest, and is asserted below: showing the UI
// must NOT make an unpassed competition writable.
//
// Real Postgres required; skipped without DATABASE_URL. Seeds are run-unique.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
// prerender, not renderToStaticMarkup: the page is an async server component
// (it awaits requireOrgPage, getDictionary, …) and the synchronous renderer
// cannot await those. Same reason as brand-gate-split.test.tsx.
import { prerender } from "react-dom/static";

const { requireOrgPage, getUserOrgs, resolveLocale } = vi.hoisted(() => ({
  requireOrgPage: vi.fn(),
  getUserOrgs: vi.fn(),
  resolveLocale: vi.fn(),
}));

vi.mock("@/server/page-auth", () => ({ requireOrgPage }));
// Spread the original: the page's module graph pulls other helpers out of
// lib/auth, and a bare replacement would strand them.
vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  getUserOrgs,
}));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale }));

// The two client islands are stubbed to markers carrying the gate's answer, so
// "did the org get the feature?" is an exact string check rather than a guess
// at some rendered input's class name. lib/db and lib/entitlements are NOT
// stubbed — the pass overlay is the thing under test.
vi.mock("@/components/org-sponsors", () => ({
  OrgSponsors: ({ hasTiers }: { hasTiers: boolean }) => (
    <div data-testid={`sponsor-tiers-${hasTiers}`} />
  ),
}));
vi.mock("@/components/sponsor-packages", () => ({
  SponsorPackages: ({ hasMonetize }: { hasMonetize: boolean }) => (
    <div data-testid={`sponsor-monetize-${hasMonetize}`} />
  ),
}));

import { sql } from "@/lib/db";
import { hasFeature, invalidateOrgEntitlements } from "@/lib/entitlements";
import SettingsPage from "../page";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

interface Rig {
  orgId: string;
  orgSlug: string;
  passedId: string;
  plainId: string;
}

/** A COMMUNITY org (explicit subscriptions row — a raw org insert leaves none,
 *  and the pass arm only fires while the resolved plan is 'community') with two
 *  competitions, and a pass on at most one of them. */
async function seedOrg(opts: { withPass: boolean }): Promise<Rig> {
  const s = uniq();
  const orgSlug = "spon-org-" + s;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Spon Org " + s}, ${orgSlug}) returning id`;
  await sql`insert into subscriptions (org_id, plan_key, status)
            values (${orgId}, 'community', 'active')
            on conflict (org_id) do update set plan_key = 'community', status = 'active'`;
  const [{ id: passedId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, visibility)
    values (${orgId}, 'Passed Cup', ${"passed-" + s}, 'unlisted') returning id`;
  const [{ id: plainId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, visibility)
    values (${orgId}, 'Plain Cup', ${"plain-" + s}, 'unlisted') returning id`;
  if (opts.withPass) {
    await sql`insert into competition_passes (competition_id, org_id)
              values (${passedId}, ${orgId}) on conflict (competition_id) do nothing`;
  }
  await invalidateOrgEntitlements(orgId);
  return { orgId, orgSlug, passedId, plainId };
}

async function renderSponsorsTab(rig: Rig): Promise<string> {
  const org = { id: rig.orgId, name: "Spon Org", slug: rig.orgSlug, role: "owner",
    logo_url: null, logo_storage_path: null, branding: {}, timezone: "Europe/London" };
  requireOrgPage.mockResolvedValue({
    user: { id: "u1", email: "owner@test.local", display_name: "Owner", timezone: null, locale: null },
    org,
    canEdit: true,
    auth: { orgId: rig.orgId, via: "session", userId: "u1", role: "owner", keyId: null },
  });
  getUserOrgs.mockResolvedValue([org]);
  resolveLocale.mockResolvedValue("en");

  const element = await SettingsPage({
    params: Promise.resolve({ orgSlug: rig.orgSlug }),
    searchParams: Promise.resolve({ tab: "sponsors" }),
  });
  const { prelude } = await prerender(element);
  const reader = (prelude as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let html = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    html += decoder.decode(value, { stream: true });
  }
  return html;
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe.skipIf(!HAS_DB)("settings → sponsors sees an Event Pass held on any competition", () => {
  it("turns the tier picker on for a pass holder, and keeps it off without one", async () => {
    const withPass = await seedOrg({ withPass: true });
    // RED before the fix: the gate resolved org-wide, so a community org's
    // pass was invisible and this rendered the upsell instead.
    expect(await renderSponsorsTab(withPass)).toContain("sponsor-tiers-true");

    // The control arm. Without it the assertion above would still pass if the
    // helper simply answered true for everyone.
    const noPass = await seedOrg({ withPass: false });
    expect(await renderSponsorsTab(noPass)).toContain("sponsor-tiers-false");

    // …and widening the AFFORDANCE must not widen ENFORCEMENT: the write path
    // in usecases/sponsors.ts is competition-scoped, so the unpassed sibling
    // is still denied while the passed one is allowed.
    expect(await hasFeature(withPass.orgId, "sponsors.tiers", withPass.passedId)).toBe(true);
    expect(await hasFeature(withPass.orgId, "sponsors.tiers", withPass.plainId)).toBe(false);
  });

  it("turns the package composer on for a pass holder, and keeps it off without one", async () => {
    const withPass = await seedOrg({ withPass: true });
    expect(await renderSponsorsTab(withPass)).toContain("sponsor-monetize-true");

    const noPass = await seedOrg({ withPass: false });
    expect(await renderSponsorsTab(noPass)).toContain("sponsor-monetize-false");

    expect(await hasFeature(withPass.orgId, "sponsors.monetize", withPass.passedId)).toBe(true);
    expect(await hasFeature(withPass.orgId, "sponsors.monetize", withPass.plainId)).toBe(false);
  });
});
