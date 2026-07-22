// Phase 2 pass-scoping sweep — `realtime` on the two noticeboard slideshows.
//
// Both boards resolved `realtime` ORG-WIDE while the competition was sitting
// right there: the competition board's route param IS the competition id, and
// the division board had already awaited `division.competition_id` for its own
// title. lib/entitlements.ts only consults competition_passes when a
// competition is in scope, so the live-refresh a community org paid an Event
// Pass for never turned on — the board it bought stayed static.
//
// The matrix makes this a real separation:
//   realtime  community=false  event_pass=true
// so each case asserts BOTH directions: the passed competition's board pushes
// live, and a second, unpassed competition in the SAME org does not.
//
// The page's data seams (auth, division/competition reads, slide building,
// sponsors) are stubbed — the resolver and the database are NOT, because the
// pass overlay is the thing under test. The pages return the <Slideshow>
// element directly, so the prop is read off it without rendering.
//
// Real Postgres required; skipped without DATABASE_URL. Seeds are run-unique.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const {
  requireResourcePageAuth, getCompetition, listDivisions, getDivision,
  buildDivisionSlides, orgBoardChrome, resolveSponsors,
} = vi.hoisted(() => ({
  requireResourcePageAuth: vi.fn(),
  getCompetition: vi.fn(),
  listDivisions: vi.fn(),
  getDivision: vi.fn(),
  buildDivisionSlides: vi.fn(),
  orgBoardChrome: vi.fn(),
  resolveSponsors: vi.fn(),
}));

vi.mock("@/server/page-auth", () => ({ requireResourcePageAuth }));
vi.mock("@/server/usecases/competitions", () => ({ getCompetition }));
vi.mock("@/server/usecases/divisions", () => ({ listDivisions, getDivision }));
vi.mock("@/server/slideshow-data", () => ({ buildDivisionSlides, orgBoardChrome }));
vi.mock("@/server/usecases/sponsors", () => ({ resolveSponsors }));

import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import CompetitionSlideshowPage from "../competitions/[id]/page";
import DivisionSlideshowPage from "../divisions/[id]/page";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

/** A COMMUNITY org (explicit subscriptions row — a raw org insert leaves none,
 *  and the pass arm only fires while the resolved plan is 'community') holding
 *  a pass on exactly one of two competition ids. */
async function seedOrgWithOnePass(): Promise<{
  orgId: string; orgSlug: string; passedId: string; plainId: string;
}> {
  const s = uniq();
  const orgSlug = "board-org-" + s;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Board Org " + s}, ${orgSlug}) returning id`;
  await sql`with _seed_sub as (
      insert into subscriptions (owner_user_id, plan_key, status)
      select created_by, 'community', 'active' from organizations where id = ${orgId}
      returning id
    )
    update organizations set subscription_id = (select id from _seed_sub) where id = ${orgId}`;
  const [{ id: passedId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, visibility)
    values (${orgId}, 'Passed Cup', ${"passed-" + s}, 'unlisted') returning id`;
  const [{ id: plainId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, visibility)
    values (${orgId}, 'Plain Cup', ${"plain-" + s}, 'unlisted') returning id`;
  await sql`insert into competition_passes (competition_id, org_id)
            values (${passedId}, ${orgId}) on conflict (competition_id) do nothing`;
  await invalidateOrgEntitlements(orgId);
  return { orgId, orgSlug, passedId, plainId };
}

/** Point the stubbed seams at this org; the resolver still runs for real. */
function arm(orgId: string, orgSlug: string): void {
  requireResourcePageAuth.mockImplementation(async () => ({
    auth: { orgId, via: "session", userId: "u1", role: "owner", keyId: null },
    user: { id: "u1", email: "owner@test.local" },
    org: { id: orgId, slug: orgSlug, role: "owner" },
    canEdit: true,
    canScore: true,
  }));
  getCompetition.mockResolvedValue({ id: "c", name: "Cup", slug: "cup", branding: {} });
  listDivisions.mockResolvedValue([]);
  buildDivisionSlides.mockResolvedValue([]);
  orgBoardChrome.mockResolvedValue({ branding: null, logo: null, themed: false });
  resolveSponsors.mockResolvedValue([]);
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

describe.skipIf(!HAS_DB)("noticeboard slideshows resolve `realtime` against their competition", () => {
  it("competition board: live on the passed competition, static on an unpassed one", async () => {
    const { orgId, orgSlug, passedId, plainId } = await seedOrgWithOnePass();
    arm(orgId, orgSlug);

    // The route param IS the competition id — nothing else to look up.
    const passed = await CompetitionSlideshowPage({ params: Promise.resolve({ id: passedId }) });
    const plain = await CompetitionSlideshowPage({ params: Promise.resolve({ id: plainId }) });

    // RED before the fix: `realtime` was resolved org-wide, so the pass was
    // invisible and BOTH boards came back false.
    expect(passed.props.realtime).toBe(true);
    // The pass lifts ONE competition — a sibling board must stay static.
    expect(plain.props.realtime).toBe(false);
  });

  it("division board: live under the passed competition, static under an unpassed one", async () => {
    const { orgId, orgSlug, passedId, plainId } = await seedOrgWithOnePass();
    arm(orgId, orgSlug);

    // The division id resolves to its competition — already awaited by the
    // page for the board title, so the id costs nothing extra.
    getDivision.mockResolvedValueOnce({
      id: "d1", competition_id: passedId, name: "Open", slug: "open",
    });
    const passed = await DivisionSlideshowPage({ params: Promise.resolve({ id: "d1" }) });
    getDivision.mockResolvedValueOnce({
      id: "d2", competition_id: plainId, name: "Open", slug: "open",
    });
    const plain = await DivisionSlideshowPage({ params: Promise.resolve({ id: "d2" }) });

    expect(passed.props.realtime).toBe(true);
    expect(plain.props.realtime).toBe(false);
  });
});
