// <UpgradeGate>'s three states (spec 2026-07-21 D1, task 17).
//
// The failure being fixed: a community org that has ALREADY BOUGHT the $29
// Event Pass for the competition it is looking at was still offered that same
// pass at every paywall underneath it. The gate inferred the pass CTA from
// usePathname() alone, so "am I in a competition" was the only question it
// could ask; "do we already own this one" was unanswerable.
//
// Task 16 made it answerable: the competition layout resolves
// `competition_passes` once and provides it through CompetitionPassProvider.
// This file pins what the gate does with that answer.
//
//   pass NOT held, liftable feature   → both paths (unchanged)
//   pass HELD, liftable feature       → Pro only; the pass is at its ceiling
//   pass HELD, non-pass feature       → Pro only; "not included in the Event Pass"
//   PAID PLAN, anything               → Pro only; the pass is moot
//   no provider (org-level page)      → exactly as before, no pass wording
//
// The fourth row is task 17's own deferred follow-up. `usePassActive()` answered
// only "does a pass ROW exist", so an org already on a paid plan read false and
// was offered the $29 pass — which for a Pro org is a DOWNGRADE, not a redundant
// sale: the pass grants 10 AI runs per division against Pro's 20, and 64
// entrants per division against Pro's 256. The layout now carries the resolved
// plan alongside the pass row and the gate reads one union.
//
// Rendered through react-dom/server, like competition-pass-provider.test.tsx:
// the suite runs in the node environment and the gate has no effects.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { CompetitionPassProvider } from "@/components/competition-pass-provider";
import { PASS_FEATURES, UpgradeGate } from "@/components/upgrade-gate";
import { formatMinor, passPrice } from "@/lib/currency";

// usePathname is the gate's only other input; a module-level handle lets each
// case place the gate on a different route.
let pathname: string | null = "/o/riverside/c/summer-league/d/new";
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));

const PASS_PRICE = formatMinor(passPrice("usd"), "usd"); // "$29"

/** A key the pass lifts, and one it can never lift. */
const LIFTABLE = "divisions.per_competition.max";
const NOT_LIFTABLE = "scheduling.multi_division";

// The CTA carries `?feature=<key>`: the upgrade page keys its ceiling state off
// that param, the gate is the only place that knows which key was refused, and
// without it the page falls back to the generic owned card. Asserted WITH the
// query rather than relaxed to a prefix — a bare `/upgrade` would satisfy a
// prefix match and silently lose the ceiling state again.
const UPGRADE_HREF = `/o/riverside/c/summer-league/upgrade?feature=${LIFTABLE}`;

/**
 * Render the gate with the competition layout's two facts.
 *
 * `provider` defaults to "a provider is mounted iff one of the facts is set",
 * which keeps every pre-existing call site meaning what it meant. Pass it
 * explicitly for the control arm: a community org with no pass IS inside a
 * competition, and must still see the $29 path.
 */
function render(
  node: ReactNode,
  {
    passActive = false,
    paidPlan = false,
    provider = passActive || paidPlan,
  }: { passActive?: boolean; paidPlan?: boolean; provider?: boolean } = {},
) {
  return renderToStaticMarkup(
    provider ? (
      <CompetitionPassProvider active={passActive} paidPlan={paidPlan}>
        {node}
      </CompetitionPassProvider>
    ) : (
      node
    ),
  );
}

describe("UpgradeGate — pass not held (unchanged behaviour)", () => {
  it("offers both paths for a liftable feature inside a competition", () => {
    pathname = "/o/riverside/c/summer-league/d/new";
    const html = render(<UpgradeGate feature={LIFTABLE} />);
    expect(html).toContain("data-pass-gate");
    expect(html).toContain(`href="${UPGRADE_HREF}"`);
    expect(html).toContain(PASS_PRICE);
    expect(html).toContain("/settings/billing");
  });

  it("says nothing about an owned pass, and promises no credit", () => {
    // The credit line is goodwill for money already spent. Showing it to
    // someone who has not bought a pass advertises a discount they cannot get.
    pathname = "/o/riverside/c/summer-league/d/new";
    const html = render(<UpgradeGate feature={LIFTABLE} />);
    expect(html).not.toContain("data-pass-owned");
    expect(html).not.toMatch(/30 days/);
  });

  it("stays Pro-only on an org-level page, with no provider above it", () => {
    // The regression that matters most: usePassActive() defaults to false, so
    // /o/[orgSlug]/settings/billing must render exactly what it renders today.
    pathname = "/o/riverside/settings/billing";
    const html = render(<UpgradeGate feature={LIFTABLE} />);
    expect(html).not.toContain("data-pass-gate");
    expect(html).not.toContain("data-pass-owned");
    expect(html).toContain("See plans &amp; upgrade");
  });
});

describe("UpgradeGate — pass held (D1: never re-sell a pass the org holds)", () => {
  it("drops the $29 CTA at the pass's own ceiling", () => {
    // divisions.per_competition.max IS lifted by the pass (2 → 10). Seeing
    // this gate with a pass active means all 10 are used: another $29 buys
    // nothing, and Pro is the only real answer.
    pathname = "/o/riverside/c/summer-league/d/new";
    const html = render(<UpgradeGate feature={LIFTABLE} />, { passActive: true });
    expect(html).not.toContain(UPGRADE_HREF);
    expect(html).not.toContain(PASS_PRICE);
    expect(html).not.toContain("data-pass-gate");
    expect(html).toContain("data-pass-owned");
    expect(html).toContain("/settings/billing");
  });

  it("credits the pass already bought, within the window the credit code honours", () => {
    // server/usecases/pass-credit.ts: a pass BOUGHT (non-null payment intent)
    // within PASS_CREDIT_WINDOW_DAYS=30 is credited in full. The copy must
    // stay conditional on both, or it promises what the code refuses.
    pathname = "/o/riverside/c/summer-league/d/new";
    const html = render(<UpgradeGate feature={LIFTABLE} />, { passActive: true });
    expect(html).toMatch(/bought in the last 30 days/i);
    expect(html).toMatch(/first Pro invoice/i);
  });

  it("says the feature is not on the pass when the pass could never lift it", () => {
    pathname = "/o/riverside/c/summer-league/schedule";
    const html = render(<UpgradeGate feature={NOT_LIFTABLE} />, { passActive: true });
    expect(html).toContain("data-pass-owned");
    expect(html).toMatch(/not included in the Event Pass/i);
    expect(html).not.toContain(PASS_PRICE);
  });

  it("distinguishes the ceiling from a feature the pass never covered", () => {
    // Both are Pro-only cards; the two must not collapse into one message.
    // "You've used everything the pass gives" and "the pass never gave this"
    // are different sales conversations.
    pathname = "/o/riverside/c/summer-league/d/new";
    const ceiling = render(<UpgradeGate feature={LIFTABLE} />, { passActive: true });
    const outside = render(<UpgradeGate feature={NOT_LIFTABLE} />, { passActive: true });
    expect(ceiling).toMatch(/used everything the Event Pass includes/i);
    expect(ceiling).not.toMatch(/not included in the Event Pass/i);
    expect(outside).toMatch(/not included in the Event Pass/i);
    expect(outside).not.toMatch(/used everything the Event Pass includes/i);
  });

  it("never re-sells the pass for ANY key the pass lifts", () => {
    // The set is derived from the live matrix by
    // upgrade-gate-pass-features.test.ts, so a key added there is covered here
    // automatically — no second hand-written list to drift.
    pathname = "/o/riverside/c/summer-league/d/new";
    for (const feature of PASS_FEATURES) {
      const html = render(<UpgradeGate feature={feature} />, { passActive: true });
      expect(html, feature).not.toContain(UPGRADE_HREF);
      expect(html, feature).not.toContain("data-pass-cta");
    }
  });

  it("names the plan that actually unlocks the key, not always Pro", () => {
    // A pass holder can hit a Pro PLUS gate inside the competition they paid
    // for (auto-assigning officials, write API keys, custom domains). The
    // card carries a PRO PLUS badge, so a "Go Pro" button underneath it would
    // send them to buy the wrong plan.
    pathname = "/o/riverside/c/summer-league/d/main";
    const html = render(<UpgradeGate feature="officials.auto" />, { passActive: true });
    expect(html).toContain("Go Pro Plus");
    expect(html).not.toMatch(/Go Pro —/);
  });

  it("sends the compact pill to billing, not to a second checkout", () => {
    // The toolbar pill is one link with no room for two paths; with a pass
    // held it must not be the $29 one.
    pathname = "/o/riverside/c/summer-league/d/main/schedule";
    const html = render(<UpgradeGate feature={LIFTABLE} compact />, { passActive: true });
    expect(html).not.toContain(UPGRADE_HREF);
    expect(html).toContain('href="/settings/billing"');
  });

  it("honours an explicit href for the Pro path", () => {
    pathname = "/o/riverside/c/summer-league/d/new";
    const html = render(<UpgradeGate feature={LIFTABLE} href="/settings/billing#plans" />, {
      passActive: true,
    });
    expect(html).toContain('href="/settings/billing#plans"');
  });
});

describe("UpgradeGate — paid plan (D1: any paid plan → Pro path only)", () => {
  // Every key the pass lifts is one a paid plan lifts FURTHER — that is why
  // lib/entitlements.ts applies the pass arm only when the resolved plan is
  // community. Selling the pass to a paid org therefore sells strictly less
  // than they hold: 10 AI runs per division against Pro's 20, 64 entrants
  // against Pro's 256.
  const DOWNGRADE_KEYS = [
    "scheduling.ai.runs_per_division.max",
    "entrants.per_division.max",
  ];

  it("drops the $29 path for a paid org that hits a liftable ceiling", () => {
    pathname = "/o/riverside/c/summer-league/d/new";
    const html = render(<UpgradeGate feature={LIFTABLE} />, { paidPlan: true });
    expect(html).not.toContain(UPGRADE_HREF);
    expect(html).not.toContain(PASS_PRICE);
    expect(html).not.toContain("data-pass-gate");
    expect(html).not.toContain("data-pass-cta");
    expect(html).toContain("See plans &amp; upgrade");
  });

  it("never offers a pass that grants LESS than the plan already held", () => {
    // The two rows from the live matrix where the pass is a strict downgrade.
    pathname = "/o/riverside/c/summer-league/d/main";
    for (const feature of DOWNGRADE_KEYS) {
      expect(PASS_FEATURES.has(feature), feature).toBe(true);
      const html = render(<UpgradeGate feature={feature} />, { paidPlan: true });
      expect(html, feature).not.toContain(UPGRADE_HREF);
      expect(html, feature).not.toContain(PASS_PRICE);
    }
  });

  it("suppresses the pass for EVERY key the pass lifts", () => {
    // Derived from the live matrix by upgrade-gate-pass-features.test.ts, so a
    // key added there is covered here with no second list to drift.
    pathname = "/o/riverside/c/summer-league/d/new";
    for (const feature of PASS_FEATURES) {
      const html = render(<UpgradeGate feature={feature} />, { paidPlan: true });
      expect(html, feature).not.toContain(UPGRADE_HREF);
      expect(html, feature).not.toContain("data-pass-cta");
    }
  });

  it("does not tell a paid org it holds an Event Pass, or promise it a credit", () => {
    // The pass-owned card explains a block by the PASS's ceiling and offers a
    // credit for money spent on a pass. A paid org was blocked by its PLAN and
    // may never have bought a pass at all; both statements would be false.
    pathname = "/o/riverside/c/summer-league/d/new";
    const html = render(<UpgradeGate feature={LIFTABLE} />, { paidPlan: true });
    expect(html).not.toContain("data-pass-owned");
    expect(html).not.toMatch(/Event Pass/i);
    expect(html).not.toMatch(/30 days/);
  });

  it("keeps the paid-plan card identical to the org-level one", () => {
    // No new state was invented: a paid org inside a competition renders the
    // same Pro-only card an org-level page has always rendered.
    pathname = "/o/riverside/c/summer-league/d/new";
    const inComp = render(<UpgradeGate feature={LIFTABLE} />, { paidPlan: true });
    pathname = "/o/riverside/settings/billing";
    const orgLevel = render(<UpgradeGate feature={LIFTABLE} />);
    expect(inComp).toBe(orgLevel);
  });

  it("sends the compact pill to billing rather than the $29 checkout", () => {
    pathname = "/o/riverside/c/summer-league/d/main/schedule";
    const html = render(<UpgradeGate feature={LIFTABLE} compact />, { paidPlan: true });
    expect(html).not.toContain(UPGRADE_HREF);
    expect(html).toContain('href="/settings/billing"');
    expect(html).not.toContain("data-pass-owned");
  });

  it("beats a pass row the org still holds", () => {
    // A community org can buy a pass and then upgrade; the row survives. Under
    // a paid plan lib/entitlements.ts stops consulting the pass entirely, so a
    // gate firing here is the PLAN's ceiling and the pass explains nothing.
    pathname = "/o/riverside/c/summer-league/d/new";
    const html = render(<UpgradeGate feature={LIFTABLE} />, {
      passActive: true,
      paidPlan: true,
    });
    expect(html).not.toContain("data-pass-owned");
    expect(html).not.toContain(PASS_PRICE);
    expect(html).not.toMatch(/used everything the Event Pass includes/i);
  });

  it("still offers the $29 path to a community org in the same competition", () => {
    // The control arm. Without it every assertion above would pass on a gate
    // that had simply stopped rendering the pass CTA anywhere.
    pathname = "/o/riverside/c/summer-league/d/new";
    const html = render(<UpgradeGate feature={LIFTABLE} />, {
      provider: true,
      paidPlan: false,
    });
    expect(html).toContain("data-pass-gate");
    expect(html).toContain(`href="${UPGRADE_HREF}"`);
    expect(html).toContain(PASS_PRICE);
  });

  it("leaves the pass-held card untouched for a community org", () => {
    // The other control arm: task 17's state must survive this change.
    pathname = "/o/riverside/c/summer-league/d/new";
    const html = render(<UpgradeGate feature={LIFTABLE} />, { passActive: true });
    expect(html).toContain("data-pass-owned");
    expect(html).toMatch(/used everything the Event Pass includes/i);
    expect(html).not.toContain(PASS_PRICE);
  });
});

describe("UpgradeGate — the pass CTA still appears where it should", () => {
  it("is absent on /c/new, which is not a competition yet", () => {
    pathname = "/o/riverside/c/new";
    const html = render(<UpgradeGate feature={LIFTABLE} />);
    expect(html).not.toContain("data-pass-cta");
  });

  it("is absent for a feature the pass does not lift", () => {
    pathname = "/o/riverside/c/summer-league/schedule";
    const html = render(<UpgradeGate feature={NOT_LIFTABLE} />);
    expect(html).not.toContain("data-pass-cta");
    expect(html).not.toContain("data-pass-owned");
  });
});
