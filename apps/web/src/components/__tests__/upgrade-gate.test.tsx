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
//   no provider (org-level page)      → exactly as before, no pass wording
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
const UPGRADE_HREF = "/o/riverside/c/summer-league/upgrade";

/** A key the pass lifts, and one it can never lift. */
const LIFTABLE = "divisions.per_competition.max";
const NOT_LIFTABLE = "scheduling.multi_division";

function render(node: ReactNode, { passActive = false } = {}) {
  return renderToStaticMarkup(
    passActive ? <CompetitionPassProvider active>{node}</CompetitionPassProvider> : node,
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
