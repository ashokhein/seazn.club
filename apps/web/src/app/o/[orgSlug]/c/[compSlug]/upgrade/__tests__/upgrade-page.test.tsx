// The Event Pass upgrade page, rendered in each of its five states (spec D10).
//
// What was wrong. The page had three branches for five situations:
//
//   * a NON-OWNER got the full priced card with a sentence under it, which is a
//     price nobody will let them pay;
//   * the OWNED state was a dead-end green box — it confirmed the purchase and
//     offered nothing next: no receipt for the $29, and no way to Pro, on the
//     one page a converting customer is already standing on;
//   * a buyer sent back here by the pass's OWN ceiling got that same "you're
//     all set" box while still blocked, with no explanation and no action;
//   * `isPro` was read from `subscriptions.plan_key` RAW, which gets a lapsed
//     staff comp and a past-grace past_due org backwards in both directions.
//
// Rendered through react-dom/server — vitest runs `environment: "node"` and
// this workspace has no jsdom (same pattern as pass-checkout-parity.test.tsx).
// Everything the page talks to is mocked EXCEPT the dictionary and the pure
// state/comparison modules: the assertions below are about copy and about which
// controls exist, so the real `en` strings have to be in play.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const h = vi.hoisted(() => ({
  role: "owner" as string,
  planKey: "community" as string,
  passRow: null as { purchased_at: string; stripe_payment_intent: string | null } | null,
  purchases: [] as unknown[],
  reconciled: [] as string[],
  matrix: [
    { plan_key: "community", feature_key: "divisions.per_competition.max", bool_value: null, int_value: 2 },
    { plan_key: "event_pass", feature_key: "divisions.per_competition.max", bool_value: null, int_value: 10 },
    { plan_key: "pro", feature_key: "divisions.per_competition.max", bool_value: null, int_value: null },
    { plan_key: "community", feature_key: "entrants.per_division.max", bool_value: null, int_value: 32 },
    { plan_key: "event_pass", feature_key: "entrants.per_division.max", bool_value: null, int_value: 64 },
    { plan_key: "pro", feature_key: "entrants.per_division.max", bool_value: null, int_value: 256 },
    { plan_key: "community", feature_key: "scheduling.ai.runs_per_division.max", bool_value: null, int_value: 5 },
    { plan_key: "event_pass", feature_key: "scheduling.ai.runs_per_division.max", bool_value: null, int_value: 10 },
    { plan_key: "pro", feature_key: "scheduling.ai.runs_per_division.max", bool_value: null, int_value: 20 },
    { plan_key: "community", feature_key: "registration.fee_percent", bool_value: null, int_value: 8 },
    { plan_key: "event_pass", feature_key: "registration.fee_percent", bool_value: null, int_value: 5 },
    { plan_key: "pro", feature_key: "registration.fee_percent", bool_value: null, int_value: 2 },
    { plan_key: "community", feature_key: "realtime", bool_value: false, int_value: null },
    { plan_key: "event_pass", feature_key: "realtime", bool_value: true, int_value: null },
    { plan_key: "pro", feature_key: "realtime", bool_value: true, int_value: null },
  ],
}));

vi.mock("@/server/page-auth", () => ({
  requireCompetitionPage: async () => ({
    org: { id: "org-1", name: "Riverside CC", slug: "riverside", role: h.role },
    competition: { id: "comp-1", name: "Summer League", slug: "summer-league" },
    canEdit: true,
  }),
}));

// postgres.js `sql` is BOTH a tagged template and a helper call (`sql(array)`
// builds the `in (…)` list), so the double writes both shapes.
vi.mock("@/lib/db", () => {
  const sql = (strings: TemplateStringsArray | unknown[], ...vals: unknown[]) => {
    if (!Array.isArray(strings) || !("raw" in strings)) return { __fragment: strings };
    const text = (strings as TemplateStringsArray).join(" ");
    if (text.includes("competition_passes")) return Promise.resolve(h.passRow ? [h.passRow] : []);
    if (text.includes("plan_entitlements")) return Promise.resolve(h.matrix);
    void vals;
    return Promise.resolve([]);
  };
  return { sql };
});

vi.mock("@/lib/entitlements", async (orig) => ({
  ...(await orig<typeof import("@/lib/entitlements")>()),
  orgPlanKey: async () => h.planKey,
}));
vi.mock("@/lib/currency-server", () => ({ preferredCurrency: async () => "usd" }));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: async () => "en" }));
vi.mock("@/lib/billing", () => ({
  reconcilePassCheckout: async (_org: string, session: string) => {
    h.reconciled.push(session);
  },
}));
vi.mock("@/server/usecases/billing-manage", () => ({ getPassPurchases: async () => h.purchases }));
// Client islands: the real ones pull Stripe.js and the DictProvider context.
vi.mock("@/components/pass-upgrade", () => ({
  PassUpgradeButton: ({ label }: { label: string }) => <button data-pass-buy>{label}</button>,
}));
vi.mock("@/components/ui/tip", () => ({ Tip: () => <span data-tip /> }));

import Page from "../page";

const RECEIPT = {
  competitionId: "comp-1",
  competitionName: "Summer League",
  competitionSlug: "summer-league",
  purchasedIso: "2026-07-10T09:00:00.000Z",
  amountMinor: 2900,
  currency: "usd",
  hostedInvoiceUrl: "https://invoice.stripe.com/i/acct_1/test_abc",
};

async function render(search: Record<string, string> = {}): Promise<string> {
  const el = await Page({
    params: Promise.resolve({ orgSlug: "riverside", compSlug: "summer-league" }),
    searchParams: Promise.resolve(search),
  });
  return renderToStaticMarkup(el);
}

beforeEach(() => {
  h.role = "owner";
  h.planKey = "community";
  h.passRow = null;
  h.purchases = [];
  h.reconciled = [];
});

/** A pass bought `days` ago, paid unless told otherwise. */
function heldPass({ days = 3, intent = "pi_live_1" as string | null } = {}) {
  h.passRow = {
    purchased_at: new Date(Date.now() - days * 86_400_000).toISOString(),
    stripe_payment_intent: intent,
  };
  h.purchases = [{ ...RECEIPT, ...(intent ? {} : { amountMinor: null, currency: null, hostedInvoiceUrl: null }) }];
}

describe("not owned — the owner", () => {
  it("offers the pass at its price, with a way to buy it", async () => {
    const html = await render();
    expect(html).toContain("data-pass-ticket");
    expect(html).toContain("$29");
    expect(html).toContain("data-pass-buy");
    expect(html).toContain("Buy the pass");
  });

  it("names the real limits rather than a hardcoded claim", async () => {
    // The dictionary used to promise "32 entrants per division (Free: 16)"
    // while the matrix granted 64 against Community's 32 — undersold by half
    // and wrong about the free plan, in four languages. Every figure now comes
    // from plan_entitlements.
    const html = await render();
    expect(html).toContain("Entrants per division");
    expect(html).toContain(">32<");
    expect(html).toContain(">64<");
    expect(html).toContain(">256<");
    expect(html).not.toContain("Free: 16");
  });

  it("renders Pro's absent division cap as unlimited, not as a blank", async () => {
    expect(await render()).toContain("Unlimited");
  });
});

describe("not owned — a non-owner", () => {
  it("explains instead of offering a checkout nobody would let them reach", async () => {
    h.role = "admin";
    const html = await render();
    expect(html).toContain("Only the organization owner can purchase upgrades.");
    expect(html).not.toContain("data-pass-buy");
  });

  it("still shows the price and what it buys", async () => {
    // U4 is "owner-only message, no checkout", not "no information": an admin's
    // next move is to take a number to whoever can spend it.
    h.role = "admin";
    const html = await render();
    expect(html).toContain("$29");
    expect(html).toContain("Entrants per division");
  });
});

describe("owned", () => {
  it("signals the pass is active", async () => {
    heldPass();
    const html = await render();
    // pricing-v3.spec.ts waits on this hook after a purchase — it is a live
    // e2e contract, not decoration.
    expect(html).toContain("data-pass-active");
    expect(html).toContain("Event Pass active");
  });

  it("links the receipt for the money that was taken", async () => {
    heldPass();
    const html = await render();
    expect(html).toContain("data-pass-receipt");
    expect(html).toContain(RECEIPT.hostedInvoiceUrl);
    expect(html).toContain("View receipt");
  });

  it("offers the step after the pass", async () => {
    // The whole defect in the old owned state: a green box that confirmed the
    // purchase and offered nothing next.
    heldPass();
    const html = await render();
    expect(html).toContain("Running more than this one?");
    expect(html).toContain("/o/riverside/settings/billing");
  });

  it("never re-sells the pass it just confirmed", async () => {
    heldPass();
    const html = await render();
    expect(html).not.toContain("data-pass-buy");
    expect(html).not.toContain("$29");
  });

  it("promises the credit only while pass-credit.ts would actually pay it", async () => {
    heldPass({ days: 3 });
    expect(await render()).toContain(
      "An Event Pass bought in the last 30 days comes off your first Pro invoice in full.",
    );

    // `outside_window` — PASS_CREDIT_WINDOW_DAYS is 30 and inclusive.
    heldPass({ days: 45 });
    expect(await render()).not.toContain("comes off your first");
  });

  it("says nothing about a credit for a pass nobody paid for", async () => {
    // A staff grant has a null `stripe_payment_intent` and returns
    // `unpaid_pass`. Promising it a refund of $29 that was never charged is a
    // support ticket the copy created.
    heldPass({ intent: null });
    const html = await render();
    expect(html).not.toContain("comes off your first");
    expect(html).toContain("nothing was charged");
    expect(html).not.toContain("data-pass-receipt");
  });

  it("explains a missing receipt rather than linking a dead one", async () => {
    // A paid pass whose Stripe read failed keeps its row and loses its money
    // columns (getPassPurchases degrades, never drops). A "View receipt" link
    // to nowhere is worse than the sentence that says why there isn't one.
    heldPass();
    h.purchases = [{ ...RECEIPT, amountMinor: null, currency: null, hostedInvoiceUrl: null }];
    const html = await render();
    expect(html).not.toContain("data-pass-receipt");
    expect(html).toContain("The receipt is still being prepared.");
  });
});

describe("owned, at the pass's ceiling", () => {
  it("says the pass has run out on a key it does cover", async () => {
    heldPass();
    const html = await render({ feature: "entrants.per_division.max" });
    expect(html).toContain("The Event Pass stops here");
    expect(html).toContain("You’ve used everything the Event Pass includes here.");
  });

  it("says a Pro-only key was never on the pass", async () => {
    heldPass();
    const html = await render({ feature: "scheduling.board" });
    expect(html).toContain("This one is not included in the Event Pass.");
  });

  it("picks out the limit that blocked them", async () => {
    heldPass();
    expect(await render({ feature: "entrants.per_division.max" })).toContain("data-ceiling-row");
  });

  it("sells only Pro, with the credit, and never the pass again", async () => {
    heldPass();
    const html = await render({ feature: "entrants.per_division.max" });
    expect(html).not.toContain("data-pass-buy");
    expect(html).not.toContain("$29");
    expect(html).toContain("comes off your first Pro invoice in full");
  });
});

describe("already on a paid plan", () => {
  it("offers no pass, at no price, in any form", async () => {
    // THE regression this state exists to prevent (f70b8e52): the pass grants
    // 10 AI runs per division against pro's 20 and 64 entrants against 256, so
    // an offer here sells a customer strictly LESS than they hold.
    h.planKey = "pro";
    const html = await render();
    expect(html).not.toContain("data-pass-buy");
    expect(html).not.toContain("data-pass-cta");
    expect(html).not.toContain("data-pass-ticket");
    expect(html).not.toContain("$29");
  });

  it("compares against the plan the org actually has", async () => {
    h.planKey = "pro_plus";
    const html = await render();
    expect(html).toContain("Pro Plus");
    // No Event Pass column either: a $29 column beside their plan is the quiet
    // version of the same sale.
    expect(html).not.toContain("Event Pass</th>");
  });

  it("keeps a pass the org bought before it upgraded", async () => {
    // U15 — the pass is bought outright and survives a downgrade. Silence here
    // would read as if the $29 had been absorbed by the subscription.
    h.planKey = "pro";
    heldPass();
    const html = await render();
    expect(html).toContain("data-pass-dormant");
    expect(html).not.toContain("data-pass-buy");
  });

  it("still says the pass is moot rather than pretending it is unavailable", async () => {
    h.planKey = "pro";
    expect(await render()).toContain("already covers everything an Event Pass adds");
  });
});

describe("returning from checkout", () => {
  it("reconciles the session before deciding which state to render", async () => {
    // The pass must lift gates before any webhook lands, and this read is what
    // picks the state the buyer lands in.
    await render({ checkout: "success", session_id: "cs_test_1" });
    expect(h.reconciled).toEqual(["cs_test_1"]);
  });

  it("does not reconcile without a session id", async () => {
    await render({ checkout: "success" });
    expect(h.reconciled).toEqual([]);
  });
});
