// The dashboard card menu's Event Pass offer, rendered (v17 gap #353).
//
// The menu offered "Event Pass — from $29" on EVERY un-passed competition an
// editor could see, including ones that were finished, archived, or a week past
// their end date. The checkout route now refuses those with a 410 — but a live
// button that leads to a refusal is still a promise the product cannot keep, and
// before the route gate it led to a completed sale for a pass that applied to
// nothing.
//
// Rendered rather than source-scanned, deliberately. `pass-entry-points.test.ts`
// is a source scan and it says so: a scan pins syntax rather than meaning, and
// the task 6 review found `passLock.get(c.id) === "terminal"` satisfying every
// assertion in that file while re-shipping #301 for the whole `past_ends_on`
// arm. The specific hole this file exists to close is a suppression built on a
// column the query never selected: `isPassLocked(undefined, undefined)` answers
// "not locked" for every competition on the page, and a source scan cannot tell
// that apart from a working gate.
//
// Rendered through react-dom/server — vitest runs `environment: "node"` and this
// workspace has no jsdom (same pattern as the upgrade page's own suite).
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const h = vi.hoisted(() => ({
  planKey: "community" as string,
  canEdit: true,
  competitions: [] as Array<{
    id: string;
    name: string;
    slug: string;
    status: string;
    ends_on: string | null;
  }>,
}));

vi.mock("@/server/page-auth", () => ({
  requireOrgPage: async () => ({
    // `userId: null` keeps the onboarding write out of the way — it is a
    // dynamic import of a module that talks to Postgres, and this page renders
    // it before anything else.
    auth: { orgId: "org-1", via: "session", userId: null, role: "owner", keyId: null },
    user: { id: "u-1" },
    org: { id: "org-1", name: "Riverside CC", slug: "riverside", role: "owner" },
    canEdit: h.canEdit,
  }),
}));

vi.mock("@/server/usecases/competitions", () => ({
  listCompetitions: async () => ({ items: h.competitions, next_cursor: null }),
}));
vi.mock("@/server/usecases/card-stats", () => ({
  listCompetitionCardStats: async () => new Map(),
  nextLine: () => null,
}));

// The only query the page issues itself is the held-pass read. Nothing here
// holds a pass — a held pass suppresses the offer on its own and would make
// every case below pass for the wrong reason.
vi.mock("@/lib/db", () => ({
  sql: (strings: TemplateStringsArray | unknown[], ...vals: unknown[]) => {
    void vals;
    if (!Array.isArray(strings) || !("raw" in strings)) return { __fragment: strings };
    return Promise.resolve([]);
  },
}));

// PARTIAL: `isPassLocked` stays REAL. Replacing it would make this file assert
// that the page calls a stub, which is precisely the vacuity it exists to avoid.
vi.mock("@/lib/entitlements", async (orig) => ({
  ...(await orig<typeof import("@/lib/entitlements")>()),
  orgPlanKey: async () => h.planKey,
}));
vi.mock("@/lib/currency-server", () => ({ preferredCurrency: async () => "usd" }));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: async () => "en" }));
vi.mock("@/components/billing-banner", () => ({ BillingBanner: () => null }));

// The card chrome, stubbed down to the one thing under test. <CardMenu> renders
// its items only once OPENED (it is a client popover), so against the real
// component every assertion below would read "absent" forever — a green suite
// pinning nothing at all.
vi.mock("@/components/ui/entity-card", () => ({
  EntityCard: (p: { name: string; menu?: React.ReactNode }) => (
    <div data-card={p.name}>{p.menu}</div>
  ),
}));
vi.mock("@/components/ui/card-menu", () => ({
  CardMenu: (p: { items: Array<{ label: string; href: string }> }) => (
    <ul data-card-menu>
      {p.items.map((i) => (
        <li key={i.href} data-menu-href={i.href}>
          {i.label}
        </li>
      ))}
    </ul>
  ),
}));
vi.mock("@/components/ui/view-toggle", () => ({
  ViewToggleContainer: (p: { children?: React.ReactNode }) => <div>{p.children}</div>,
}));

import Page from "../page";
import { PASS_END_GRACE_DAYS } from "@/lib/entitlements";

/** The UTC calendar date `offsetDays` from today, as 'YYYY-MM-DD'. The lock
 *  boundary is a date-only comparison against the UTC day; a local-midnight
 *  `new Date(...)` sits hours off it, exactly where `<` and `<=` stop being
 *  distinguishable. */
const utcDay = (offsetDays: number): string => {
  const now = new Date();
  const dayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(dayMs + offsetDays * 86_400_000).toISOString().slice(0, 10);
};

const comp = (over: Partial<(typeof h.competitions)[number]> = {}) => ({
  id: "comp-1",
  name: "Summer League",
  slug: "summer-league",
  status: "live",
  ends_on: null as string | null,
  ...over,
});

const render = async (): Promise<string> =>
  renderToStaticMarkup(await Page({ params: Promise.resolve({ orgSlug: "riverside" }) }));

/** Does the card menu invite a pass purchase? Keyed on the HREF rather than on
 *  the price string: the label is derived from the ladder floor and moves with
 *  a price change, while the upgrade route is what the offer actually is. */
const offersPass = (html: string) => html.includes('data-menu-href="/o/riverside/c/summer-league/upgrade"');

beforeEach(() => {
  h.planKey = "community";
  h.canEdit = true;
  h.competitions = [comp()];
});

describe("the dashboard card menu offers the pass only while it could apply", () => {
  it("offers it on a running competition — the positive this whole file rests on", async () => {
    // Without this every absence below is satisfied by a page that offers the
    // pass to nobody, which is a different bug wearing this fix's clothes.
    const html = await render();
    expect(offersPass(html)).toBe(true);
    expect(html).toContain("Event Pass");
  });

  it("drops it on a COMPLETED competition", async () => {
    h.competitions = [comp({ status: "completed" })];
    const html = await render();
    expect(offersPass(html)).toBe(false);
    // The rest of the menu is untouched — this suppresses one item, not the card.
    expect(html).toContain('data-menu-href="/o/riverside/c/summer-league/schedule"');
  });

  it("drops it on an ARCHIVED competition", async () => {
    h.competitions = [comp({ status: "archived" })];
    expect(offersPass(await render())).toBe(false);
  });

  it("drops it on a still-LIVE competition whose end date is past the grace week", async () => {
    // The arm a status filter alone misses entirely, and the common one: nobody
    // goes back to mark last season 'completed'.
    h.competitions = [comp({ ends_on: utcDay(-(PASS_END_GRACE_DAYS + 1)) })];
    expect(offersPass(await render())).toBe(false);
  });

  it("KEEPS it for a competition sitting exactly on the grace boundary", async () => {
    // ends_on + grace landing ON today is still applying. The discriminator for
    // the case above: a gate that refused any past `ends_on` would pass it and
    // would silently stop selling passes during every competition's final week.
    h.competitions = [comp({ ends_on: utcDay(-PASS_END_GRACE_DAYS) })];
    expect(offersPass(await render())).toBe(true);
  });
});
