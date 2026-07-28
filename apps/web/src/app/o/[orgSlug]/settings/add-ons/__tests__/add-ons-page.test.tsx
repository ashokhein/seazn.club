// The Add-ons tab's rendered surface (v17 gap #293, SPEC-6 §A5).
//
// WHY THIS FILE EXISTS. `getAddOnsTab` is thoroughly tested and the page's
// every branch was, until now, tested by nothing — no module imported it, so
// each conditional could be replaced by a literal and the whole suite stayed
// green. Three of the four holes that proves are customer-visible mis-sales:
//
//   `{view.capReduced && (`  -> `{true && (`    every healthy payer is told
//                                               their bill needs attention
//   `) : !view.isPayer ? (`  -> `) : false ? (`  every non-payer member is
//                                               handed the purchase control
//   `min={view.minExtraOrgs}` -> `min={0}`       the server's floor stops
//                                               bounding the stepper
//
// Rendered as a server component: it is an async function returning an element
// tree, so it can simply be awaited and walked. Its dependencies are mocked at
// the module boundary; the DICTIONARY is real, so a key that was never added to
// en/ui.json renders as itself and fails these assertions.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { walk, propsOf, textOf } from "@/components/__tests__/_hook-harness";
import { ExtraOrgsControl } from "@/components/extra-orgs-control";
import type { AddOnsTabView } from "@/server/usecases/add-ons-tab";

vi.mock("@/server/page-auth", () => ({
  requireOrgPage: vi.fn(async () => ({
    org: { id: "org-1", slug: "acme", role: "owner" },
    user: { id: "user-1" },
    auth: { orgId: "org-1", userId: "user-1" },
    canEdit: true,
  })),
}));
vi.mock("@/server/usecases/add-ons-tab", () => ({ getAddOnsTab: vi.fn() }));
vi.mock("@/lib/currency-server", () => ({ preferredCurrency: vi.fn(async () => "usd") }));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: vi.fn(async () => "en") }));
vi.mock("@/lib/i18n", async () => {
  // The real `t`, so interpolation and misses behave exactly as they do in
  // production; only the server-only dictionary LOADER is stubbed.
  const runtime = await vi.importActual<typeof import("@/lib/i18n-runtime")>(
    "@/lib/i18n-runtime",
  );
  const ui = (await import("@/dictionaries/en/ui.json")).default;
  return { getDictionary: async () => ui, t: runtime.t };
});

import { getAddOnsTab } from "@/server/usecases/add-ons-tab";
import AddOnsSettingsPage from "../page";

const view = vi.mocked(getAddOnsTab);

/** A healthy Pro payer; each test overrides only what it is about. */
function makeView(overrides: Partial<AddOnsTabView> = {}): AddOnsTabView {
  return {
    planKey: "pro",
    isPayer: true,
    hasLiveSubscription: true,
    addonAvailable: true,
    orgCap: 7,
    capReduced: false,
    liveOrgCount: 5,
    extraOrgCount: 2,
    minExtraOrgs: 0,
    maxExtraOrgs: 50,
    priceMinor: 900,
    ...overrides,
  };
}

async function render(overrides: Partial<AddOnsTabView> = {}) {
  view.mockResolvedValue(makeView(overrides));
  const tree = await AddOnsSettingsPage({ params: Promise.resolve({ orgSlug: "acme" }) });
  const elements = walk(tree);
  return {
    text: textOf(tree),
    control: elements.find((el) => el.type === ExtraOrgsControl),
  };
}

const GUEST = "Only the person who pays for this billing group can buy add-ons.";
const COMMUNITY = "Add-ons are available on Pro and Pro Plus.";
const NO_LIVE = "Extra organisations need an active paid subscription.";
const PAUSED = "Adding organisations is paused until this bill is up to date.";

beforeEach(() => view.mockReset());

describe("Add-ons page — who is offered the purchase", () => {
  it("gives the PAYER of a live paid group the control", async () => {
    const { control, text } = await render();
    expect(control).toBeDefined();
    // The three refusal notices are the positive discriminators: without them
    // "control is defined" would pass on a page that also shouted at the payer.
    expect(text).not.toContain(GUEST);
    expect(text).not.toContain(COMMUNITY);
    expect(text).not.toContain(NO_LIVE);
  });

  it("does NOT give a non-payer member the control", async () => {
    const { control, text } = await render({ isPayer: false });
    expect(control).toBeUndefined();
    expect(text).toContain(GUEST);
  });

  it("does NOT offer a community group anything to buy", async () => {
    const { control, text } = await render({
      planKey: "community",
      addonAvailable: false,
      priceMinor: null,
      orgCap: 1,
      extraOrgCount: 0,
    });
    expect(control).toBeUndefined();
    expect(text).toContain(COMMUNITY);
  });

  it("does NOT offer a group with no live subscription anything to buy", async () => {
    const { control, text } = await render({ hasLiveSubscription: false });
    expect(control).toBeUndefined();
    expect(text).toContain(NO_LIVE);
  });

  it("refuses to render a control with no price, even if the plan says it can buy", async () => {
    // Defensive: `addonAvailable` and `priceMinor` are computed from the same
    // catalog, so this is unreachable today — but a control quoting `null` is
    // an offer we cannot honour, and the page must not depend on that coupling
    // holding for ever.
    const { control } = await render({ addonAvailable: true, priceMinor: null });
    expect(control).toBeUndefined();
  });
});

describe("Add-ons page — the dunning notice", () => {
  it("warns when the resolver's cap is reduced, and STILL shows the control", async () => {
    const { control, text } = await render({ capReduced: true, minExtraOrgs: 2 });
    expect(text).toContain(PAUSED);
    // The rule the whole feature turns on: cancelling a rider they can no
    // longer afford is exactly what this customer is here to do.
    expect(control).toBeDefined();
  });

  it("does not warn a healthy group", async () => {
    // The negative half. `{true && (` in place of `{view.capReduced && (`
    // tells every paying customer their bill is in arrears.
    expect((await render({ capReduced: false })).text).not.toContain(PAUSED);
  });

  it("still warns a non-payer, who cannot fix it but should know", async () => {
    const { text } = await render({ capReduced: true, isPayer: false });
    expect(text).toContain(PAUSED);
    expect(text).toContain(GUEST);
  });
});

describe("Add-ons page — the numbers it hands the control", () => {
  it("passes the server's floor, ceiling, price and current count straight through", async () => {
    const { control } = await render({
      extraOrgCount: 3,
      minExtraOrgs: 2,
      maxExtraOrgs: 50,
      priceMinor: 1900,
    });
    const p = propsOf(control!);
    // `min={0}` here would silently un-bound the stepper and turn the route's
    // 423 back into the first thing the customer meets.
    expect(p.min).toBe(2);
    expect(p.initialCount).toBe(3);
    expect(p.max).toBe(50);
    expect(p.priceMinor).toBe(1900);
    expect(p.currency).toBe("usd");
  });

  it("states the capacity the customer BOUGHT", async () => {
    expect((await render({ liveOrgCount: 5, orgCap: 7 })).text).toContain(
      "Using 5 of 7 organisations on this bill.",
    );
  });

  it("says so plainly when the plan sets no limit, rather than printing null", async () => {
    const { text } = await render({ orgCap: null, liveOrgCount: 4 });
    expect(text).toContain("Using 4 organisations on this bill");
    expect(text).not.toContain("null");
  });
});
