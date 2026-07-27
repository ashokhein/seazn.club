// Standing guard for the four Event Pass entry points (task 19, spec D3).
//
// Before this change `routes.competitionUpgrade` had EXACTLY ONE inbound link
// in the entire app — `components/upgrade-gate.tsx`, the paywall. The pass was
// therefore only discoverable to someone a limit had already blocked. The four
// surfaces below are the fix.
//
// Two of them (the competition list and the billing page) are server pages that
// cannot be unit-rendered: they need cookies, an authenticated session and a
// tenant-scoped database. So what is asserted here is what is actually at risk
// on those pages — that the link exists at all, and that the decision to OFFER
// the pass is taken with the ONE shared predicate.
//
// ===========================================================================
// If you found this red, an entry point lost its link or grew a second notion
// of "is this org on a paid plan". Do NOT relax the assertion. Pro's matrix is a
// strict superset of the pass's at every key the pass lifts — so a surface that
// gets paid-ness wrong sells a paying customer a DOWNGRADE. That defect shipped
// once already (fixed in f70b8e52) and a new surface is exactly where it comes
// back.
// ===========================================================================
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dirname, "..", "..");
const read = (...parts: string[]) => readFileSync(join(SRC, ...parts), "utf8");

/**
 * Source with comments removed.
 *
 * The negative assertions below are about what the CODE does, and these files
 * explain themselves at length — a comment saying "we deliberately do not
 * filter on stripe_payment_intent" would otherwise fail the very check it
 * documents. Crude but sufficient: no file here puts `//` or `/*` inside a
 * string literal.
 */
const code = (...parts: string[]) =>
  read(...parts)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "");

const COMPETITION_HEADER = ["app", "o", "[orgSlug]", "c", "[compSlug]", "page.tsx"];
const COMPETITION_SETTINGS = ["app", "o", "[orgSlug]", "c", "[compSlug]", "settings", "page.tsx"];
const COMPETITION_LIST = ["app", "o", "[orgSlug]", "page.tsx"];
const BILLING_PAGE = ["app", "o", "[orgSlug]", "settings", "billing", "page.tsx"];
const PRICING_PAGE = ["app", "[lang]", "(marketing)", "pricing", "page.tsx"];

describe("Event Pass entry points", () => {
  it("the competition header links to the competition's upgrade page", () => {
    const src = read(...COMPETITION_HEADER);
    expect(src).toContain("CompetitionPassEntry");
    expect(src).toContain("routes.competitionUpgrade(orgSlug, compSlug)");
  });

  it("competition settings links to the competition's upgrade page", () => {
    const src = read(...COMPETITION_SETTINGS);
    expect(src).toContain("CompetitionPassEntry");
    expect(src).toContain("routes.competitionUpgrade(orgSlug, compSlug)");
  });

  it("the competition list links each un-passed competition to its upgrade page", () => {
    const src = read(...COMPETITION_LIST);
    expect(src).toContain("routes.competitionUpgrade(orgSlug, c.slug)");
  });

  it("the billing page mounts the pass offer, which owns the per-competition links", () => {
    expect(read(...BILLING_PAGE)).toContain("BillingPassOffer");
    expect(read("components", "billing-pass-offer.tsx")).toContain(
      "routes.competitionUpgrade(orgSlug, row.slug)",
    );
  });

  it("the /pricing pass column routes its CTA by who is reading", () => {
    const src = read(...PRICING_PAGE);
    expect(src).toContain("passCtaVariant");
    // The signed-in hand-off. Without it a signed-in organiser clicking the
    // Event Pass column lands on a signup form they do not need.
    expect(src).toContain('"/dashboard"');
  });
});

describe("no entry point re-derives 'is this org on a paid plan'", () => {
  // lib/entitlements.ts exports isPaidPlan + orgPlanKey precisely so this
  // question has one answer. `subscriptions.plan_key` raw is NOT that answer:
  // a lapsed staff comp and a past_due org 14 days into dunning both still
  // carry plan_key = 'pro' while resolving as community — and for those orgs
  // the pass genuinely lifts entitlements and must still be offered.
  it.each([
    ["the competition list", COMPETITION_LIST],
    ["the billing page", BILLING_PAGE],
    ["the /pricing column", PRICING_PAGE],
  ])("%s asks the resolver", (_name, parts) => {
    const src = read(...parts);
    // The resolver's verdict may be read inline (`isPaidPlan(await orgPlanKey(…))`)
    // or resolved ONCE into a local (`const effectivePlanKey = await orgPlanKey(…)`,
    // then `isPaidPlan(effectivePlanKey)`). Both feed isPaidPlan from orgPlanKey,
    // never from raw plan_key — which is the invariant this guards.
    expect(src).toMatch(/isPaidPlan\(\s*(await\s+orgPlanKey\(|effectivePlanKey\b)/);
  });

  it("the billing page's pass offer does not reuse its raw-plan_key `isPaid`", () => {
    // `isPaid` on that page is computed from sub.plan_key for the Pro upgrade
    // section and is deliberately left alone; the pass offer must not borrow it.
    // The page resolves once into `effectivePlanKey = await orgPlanKey(…)`; the
    // pass offer reads THAT, not the raw `isPaid`.
    const src = read(...BILLING_PAGE);
    expect(src).toMatch(/effectivePlanKey\s*=\s*await\s+orgPlanKey\(/);
    expect(src).toMatch(/passOfferable[\s\S]{0,200}isPaidPlan\(effectivePlanKey\b/);
  });

  it("the in-competition entry point reads the layout's one signal", () => {
    // A client island cannot query Postgres; usePassGateState is where the
    // precedence (paid plan beats held pass) is written down once.
    const src = read("components", "competition-pass-entry.tsx");
    expect(src).toContain("usePassGateState");
  });
});

describe("no entry point can re-sell a pass the org already holds", () => {
  it("the competition list drops the offer for a competition with a pass", () => {
    const src = code(...COMPETITION_LIST);
    expect(src).toContain("competition_passes");
    // Presence, never payment: a staff-granted pass has a null
    // stripe_payment_intent and is fully active (V271), so a query that
    // filtered on the intent would re-offer a pass the org already holds.
    expect(src).not.toContain("stripe_payment_intent");
  });

  it("the billing page offers only competitions with no pass row", () => {
    const src = code(...BILLING_PAGE);
    expect(src).toMatch(/not exists[\s\S]{0,200}competition_passes/);
    expect(src).not.toContain("stripe_payment_intent");
  });
});

// ===========================================================================
// v17 #294 — two rungs, and five surfaces that invite a purchase without
// offering the choice between them.
//
// The paywall, the billing-page offer, the dashboard card menu, the competition
// header and competition settings each passed the literal "event_pass" to
// `passPrice`. That is honest only while M is the CHEAPEST rung, and nothing
// held that assumption: `passPrice`'s required key made tsc enumerate these
// call sites exactly once, and after that they read as deliberate choices.
// `lowestPassRung` derives the floor instead — a discount on L, or a rung added
// underneath, moves every one of these numbers with it.
// ===========================================================================
describe("a surface that offers no rung quotes the ladder's floor", () => {
  const PAYWALL = ["components", "upgrade-gate.tsx"];
  const OFFER = ["app", "o", "[orgSlug]", "settings", "billing", "page.tsx"];

  it.each([
    ["the paywall", PAYWALL],
    ["the billing-page offer", OFFER],
    ["the dashboard card menu", COMPETITION_LIST],
    ["the competition header", COMPETITION_HEADER],
    ["competition settings", COMPETITION_SETTINGS],
  ])("%s derives its price, and names no rung", (_name, parts) => {
    const src = code(...parts);
    expect(src).toContain("lowestPassRung(");
    // The literal is what made this wrong. A surface that quotes ONE rung is
    // stating that rung's price as the product's price.
    expect(src).not.toMatch(/passPrice\(/);
  });
});

describe("the competition layout resolves what its islands cannot", () => {
  const LAYOUT = ["app", "o", "[orgSlug]", "c", "[compSlug]", "layout.tsx"];

  it("reads the pass ROW's rung, not just its existence", () => {
    // `select 1` was enough while one rung existed. The held signals under this
    // layout have nothing else on screen naming the size, so an L holder read
    // "Event Pass active" — M's product.
    const src = code(...LAYOUT);
    expect(src).toMatch(/select pass_key\s+from competition_passes/);
    // Guarded, never cast: the column is `not null default 'event_pass'`, so a
    // row written by a rung this build predates must degrade to a real label.
    expect(src).toContain("isPassKey(");
  });

  it("resolves the org's currency on the server and hands it to the client", () => {
    // A client island cannot read cookies, the org's subscription currency or
    // Accept-Language — which is why <UpgradeGate> priced every reader on earth
    // in hardcoded usd. This layout is the only provider mount, so it is the
    // only place that can fix it.
    const src = code(...LAYOUT);
    expect(src).toContain("preferredCurrency(org.id)");
    expect(src).toMatch(/currency=\{currency\}/);
  });
});

describe("the paywall is no longer the only way in", () => {
  it("routes.competitionUpgrade has more than one call site", () => {
    // The literal regression: one inbound link, reachable only after a refusal.
    const files = [
      read("components", "upgrade-gate.tsx"),
      read("components", "billing-pass-offer.tsx"),
      read(...COMPETITION_HEADER),
      read(...COMPETITION_SETTINGS),
      read(...COMPETITION_LIST),
    ];
    const callSites = files.filter((s) => s.includes("routes.competitionUpgrade(")).length;
    expect(callSites).toBeGreaterThan(1);
  });
});
