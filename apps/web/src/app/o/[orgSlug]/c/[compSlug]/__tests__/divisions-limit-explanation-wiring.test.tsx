// Both surfaces get the SAME answer from the server (#376 part C review).
//
// The sentence "divisions with recorded results count toward your limit even
// after they are archived" is only true of a refusal the archived rows
// actually caused, and that judgement needs a quota limit — something no
// client component can ask for. So `archivedSlotsExplainRefusal` is computed
// server-side and handed down, and these two pages are the only places that
// hand it down: the wizard, where a create is refused, and competition
// settings, where a restore is refused on exactly the same count.
//
// A missing prop is invisible to `tsc` — both components default it to false —
// so a page that forgot to pass it would render a silent, correct-looking
// paywall. This pins the wiring by walking each page's returned element tree
// and reading the prop off the component that consumes it. No markup is
// rendered: the assertion is about what the server handed the client, and
// `renderToStaticMarkup` would only add a client-component tree that has
// nothing to do with it.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { propsOf, walk } from "@/components/__tests__/_hook-harness";
import type { ReactElement } from "react";

const h = vi.hoisted(() => ({ explain: false }));

vi.mock("@/server/page-auth", () => ({
  requireCompetitionPage: async () => ({
    auth: { orgId: "org-1", userId: "user-1" },
    org: { id: "org-1", name: "Riverside CC", slug: "riverside", branding: null },
    competition: { id: "comp-1", name: "Summer League", slug: "summer-league" },
    canEdit: true,
  }),
}));

vi.mock("@/server/usecases/competitions", () => ({
  getCompetition: async () => ({
    id: "comp-1",
    org_id: "org-1",
    name: "Summer League",
    slug: "summer-league",
    description: null,
    starts_on: null,
    ends_on: null,
    visibility: "private",
    branding: null,
    status: "live",
    created_at: new Date().toISOString(),
    discoverable: false,
    discovery: null,
    frozen: false,
  }),
}));

// One visible division and one archived — the archived one is what competition
// settings lists, and what a Restore click would be refused on.
vi.mock("@/server/usecases/divisions", () => ({
  listDivisions: async () => [
    { id: "d-live", name: "Open", sport_key: "generic", archived_at: null },
    { id: "d-gone", name: "Retired", sport_key: "generic", archived_at: "2026-01-02T00:00:00.000Z" },
  ],
}));

// THE value under test: whichever answer the server gives must reach both
// components unchanged. Its own arithmetic is proved against a real 402 in
// server/usecases/__tests__/division-slot-disclosure.test.ts.
vi.mock("@/server/usecases/division-slots", () => ({
  archivedSlotsExplainRefusal: async () => h.explain,
}));

// `importOriginal` rather than a bare stub: competition settings reaches
// entitlements twice — `hasFeature` directly and `passLockReason` through the
// status nudge — and a hand-written object turns the second arrival into an
// "export is not defined" crash rather than a visible failure.
vi.mock("@/lib/entitlements", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/entitlements")>()),
  hasFeature: async () => false,
}));
vi.mock("@/lib/currency-server", () => ({ preferredCurrency: async () => "usd" }));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: async () => "en" }));
vi.mock("@/lib/billing", () => ({ checkoutTrialDays: () => 14 }));

vi.mock("@/lib/db", () => {
  const sql = (strings: TemplateStringsArray | unknown[]) => {
    if (!Array.isArray(strings) || !("raw" in strings)) return { __fragment: strings };
    const text = (strings as TemplateStringsArray).join(" ");
    if (text.includes("organizations")) return Promise.resolve([{ trial_used_at: null }]);
    if (text.includes("eligibility")) return Promise.resolve([{ youth: false }]);
    if (text.includes("from sports")) return Promise.resolve([{ key: "generic", name: "Generic" }]);
    if (text.includes("sport_variants"))
      return Promise.resolve([
        { sport_key: "generic", key: "score", name: "Score", is_system: true },
      ]);
    return Promise.resolve([{ total: 0, underway: 0, done: 0, scheduled: 0 }]);
  };
  return { sql, withTenant: async (_orgId: string, cb: (tx: typeof sql) => unknown) => cb(sql) };
});

import SettingsPage from "../settings/page";
import NewDivisionPage from "../d/new/page";
import { ArchivedDivisions } from "@/components/v2/archived-divisions";
import { CompetitionSettings } from "@/components/v2/competition-settings";
import { DivisionBuilder } from "@/components/v2/division-builder";

const params = Promise.resolve({ orgSlug: "riverside", compSlug: "summer-league" });

function find(tree: ReactElement[], type: unknown): ReactElement {
  const el = tree.find((e) => e.type === type);
  if (!el) throw new Error("component not found in the page's element tree");
  return el;
}

/** Competition settings hands the panel to `CompetitionSettings` as a PROP,
 *  not as a child, so `walk` cannot reach it — pull it off the prop. */
async function archivedPanel(): Promise<ReactElement> {
  const page = walk(await SettingsPage({ params }));
  return propsOf(find(page, CompetitionSettings)).archivedPanel as ReactElement;
}

async function builder(): Promise<ReactElement> {
  return find(walk(await NewDivisionPage({ params })), DivisionBuilder);
}

beforeEach(() => {
  h.explain = false;
});

describe("the archived-slot explanation is wired from the server on both surfaces", () => {
  it("competition settings passes a true answer to the restore surface", async () => {
    h.explain = true;
    const panel = await archivedPanel();

    expect(panel.type).toBe(ArchivedDivisions);
    expect(propsOf(panel).archivedSlotsExplainRefusal).toBe(true);
  });

  // The discriminating negative: a page that hardcoded `true`, or that passed
  // some other truthy value it happened to have, would pass the case above.
  it("competition settings passes a false answer through unchanged", async () => {
    h.explain = false;
    const panel = await archivedPanel();

    expect(propsOf(panel).archivedSlotsExplainRefusal).toBe(false);
  });

  it("the division wizard passes a true answer to the create surface", async () => {
    h.explain = true;

    expect(propsOf(await builder()).archivedSlotsExplainRefusal).toBe(true);
  });

  it("the division wizard passes a false answer through unchanged", async () => {
    h.explain = false;

    expect(propsOf(await builder()).archivedSlotsExplainRefusal).toBe(false);
  });
});
