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
  passRow: null as {
    purchased_at: string;
    stripe_payment_intent: string | null;
    pass_key: string;
  } | null,
  purchases: [] as unknown[],
  reconciled: [] as string[],
  // The org→group join `groupAlreadyRedeemed(subscriptionId)` needs. Defaults
  // to a real group with no redemption, so every pre-existing "credit shown"
  // case keeps meaning what it meant.
  subscriptionId: "sub-1" as string | null,
  groupRedeemed: false as boolean,
  matrix: [
    { plan_key: "community", feature_key: "divisions.per_competition.max", bool_value: null, int_value: 2 },
    { plan_key: "event_pass", feature_key: "divisions.per_competition.max", bool_value: null, int_value: 10 },
    { plan_key: "event_pass_l", feature_key: "divisions.per_competition.max", bool_value: null, int_value: 20 },
    { plan_key: "pro", feature_key: "divisions.per_competition.max", bool_value: null, int_value: null },
    { plan_key: "community", feature_key: "entrants.per_division.max", bool_value: null, int_value: 32 },
    { plan_key: "event_pass", feature_key: "entrants.per_division.max", bool_value: null, int_value: 64 },
    // null = unlimited, which is exactly what L grants (V341).
    { plan_key: "event_pass_l", feature_key: "entrants.per_division.max", bool_value: null, int_value: null },
    { plan_key: "pro", feature_key: "entrants.per_division.max", bool_value: null, int_value: 256 },
    // scheduling.ai.runs_per_division.max retired (v17 Phase 2 Task 5, V322).
    { plan_key: "community", feature_key: "registration.fee_percent", bool_value: null, int_value: 8 },
    { plan_key: "event_pass", feature_key: "registration.fee_percent", bool_value: null, int_value: 5 },
    { plan_key: "event_pass_l", feature_key: "registration.fee_percent", bool_value: null, int_value: 5 },
    { plan_key: "pro", feature_key: "registration.fee_percent", bool_value: null, int_value: 2 },
    { plan_key: "community", feature_key: "realtime", bool_value: false, int_value: null },
    { plan_key: "event_pass", feature_key: "realtime", bool_value: true, int_value: null },
    { plan_key: "event_pass_l", feature_key: "realtime", bool_value: true, int_value: null },
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
    // groupAlreadyRedeemed's own query (pass-credit.ts) — checked before the
    // org→group join below since both mention "organizations"-adjacent tables.
    if (text.includes("pass_credit_redemptions"))
      return Promise.resolve(h.groupRedeemed ? [{ one: 1 }] : []);
    if (text.includes("organizations"))
      return Promise.resolve(h.subscriptionId ? [{ id: h.subscriptionId }] : []);
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
// The picker is NOT mocked. Since v17 #294 it owns both prices, the buy
// button and the owner-only sentence, so a stand-in stub would make every
// assertion in this file about those things vacuous — the page would "contain
// $29" only because the stub was told to say so. Only Stripe.js is mocked
// (same two modules as pass-checkout-parity.test.tsx), which is all the real
// component actually needs a browser for.
vi.mock("@stripe/react-stripe-js", () => ({
  EmbeddedCheckoutProvider: (p: { children?: React.ReactNode }) => <div>{p.children}</div>,
  EmbeddedCheckout: () => <div data-stripe-embedded-checkout />,
}));
vi.mock("@/lib/stripe-browser", () => ({ stripePromise: Promise.resolve(null) }));
vi.mock("@/components/ui/tip", () => ({ Tip: () => <span data-tip /> }));

import Page from "../page";
// Pure module (no db, no server-only) — the real rung list, so the paid-plan
// guard below covers every rung that exists rather than a copy of the list.
import { PASS_KEYS } from "@/lib/currency";

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
  h.subscriptionId = "sub-1";
  h.groupRedeemed = false;
});

/** A pass bought `days` ago, paid unless told otherwise. */
function heldPass({
  days = 3,
  intent = "pi_live_1" as string | null,
  passKey = "event_pass",
} = {}) {
  h.passRow = {
    purchased_at: new Date(Date.now() - days * 86_400_000).toISOString(),
    stripe_payment_intent: intent,
    pass_key: passKey,
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

  it("offers BOTH rungs, priced, with M the one that would be bought", async () => {
    // v17 #294. The default matters beyond taste: event-pass.spec.ts clicks
    // [data-pass-buy] straight through to Stripe without touching the picker,
    // so whatever is pre-selected here is what that real-money suite buys.
    const html = await render();
    expect(html).toContain("$29");
    expect(html).toContain("$59");
    expect(html).toContain('checked="" value="event_pass"');
    expect(html).not.toContain('checked="" value="event_pass_l"');
    expect(html).toContain("Buy the pass — M");
  });

  it("compares both rungs against free and Pro, from the live matrix", async () => {
    const html = await render();
    expect(html).toContain("Event Pass M");
    expect(html).toContain("Event Pass L");
    // L's own figures, not M's: 20 divisions and a NULL entrant cap.
    expect(html).toContain(">20<");
    expect(html).toContain("Unlimited");
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

  it("names the rung that was actually bought", async () => {
    // A $59 buyer must not be shown the $29 product's name (v17 #294).
    heldPass({ passKey: "event_pass_l" });
    const html = await render();
    expect(html).toContain("Event Pass L");
    expect(html).not.toContain("Event Pass M");
  });

  it("drops the other rung's column once a pass is held", async () => {
    // There is no M->L upgrade path (#294 Q3, deferred), so a second pass
    // column here would advertise a purchase the product cannot complete —
    // and it must never price anything on a page where a pass is already held.
    heldPass();
    const html = await render();
    expect(html).toContain("Event Pass M");
    expect(html).not.toContain("Event Pass L");
    expect(html).not.toContain("$29");
    expect(html).not.toContain("$59");
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
      "An Event Pass bought in the last 30 days comes off your first Pro invoice in full " +
        "— once per billing group, the first time it subscribes.",
    );

    // `outside_window` — PASS_CREDIT_WINDOW_DAYS is 30 and inclusive.
    heldPass({ days: 45 });
    expect(await render()).not.toContain("comes off your first");
  });

  it("says nothing about a credit when the group already redeemed it", async () => {
    // A pass otherwise eligible (paid, within window) but whose billing group
    // already holds a `pass_credit_redemptions` row for a DIFFERENT pass must
    // not promise a credit this checkout will not pay out — the same rule
    // `creditPassTowardSubscription` itself enforces via `groupAlreadyRedeemed`.
    heldPass({ days: 3 });
    h.groupRedeemed = true;
    const html = await render();
    expect(html).not.toContain("comes off your first");
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
    // No pass column either: a pass column beside their plan is the quiet
    // version of the same sale.
    //
    // Asserted on the column's PLAN KEY, and on EVERY rung. This guard used to
    // read `not.toContain("Event Pass</th>")`, which the M/L rename
    // ("Event Pass" → "Event Pass M") made vacuous without touching this line —
    // `event_pass` could be put back into `columns` and the whole suite stayed
    // green. Matching the key instead makes a renamed heading irrelevant, and
    // sweeping PASS_KEYS means a third rung is covered the day it is added.
    for (const rung of PASS_KEYS) {
      expect(html).not.toContain(`data-compare-col="${rung}"`);
    }
    // And the reader's own view of the same fact, scoped to the table head so
    // it cannot be satisfied by the "your plan already covers everything an
    // Event Pass adds" sentence that PlanPanel renders elsewhere on this page.
    const head = html.slice(html.indexOf("<thead"), html.indexOf("</thead>"));
    expect(head).not.toContain("Event Pass");
    expect(head).toContain("Pro Plus");
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
