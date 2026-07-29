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
// was offered the pass — which for a Pro org is a DOWNGRADE, not a redundant
// sale: Pro's matrix is a superset of the pass's at every key the pass lifts.
// The layout now carries the resolved plan alongside the pass row and the gate
// reads one union.
//
// Rendered through react-dom/server, like competition-pass-provider.test.tsx:
// the suite runs in the node environment and the gate has no effects.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { CompetitionPassProvider } from "@/components/competition-pass-provider";
import { PASS_FEATURES, UpgradeGate } from "@/components/upgrade-gate";
import { formatMinor, passPrice, proPrice, type Currency, type PassKey } from "@/lib/currency";
import { lowestPassRung, passActiveLabel, PASS_LOCK_REASON_KEY } from "@/lib/pass-ladder";
// Type-only: `@/lib/entitlements` is a server module, and this file renders
// client components. The value side of it must never reach this bundle.
import type { PassLockReason } from "@/lib/entitlements";
import { DictProvider } from "@/components/i18n/dict-provider";
import { t } from "@/lib/i18n-runtime";
import uiEn from "@/dictionaries/en/ui.json";
import type { Dict } from "@/lib/i18n-constants";

// usePathname is the gate's only other input; a module-level handle lets each
// case place the gate on a different route.
let pathname: string | null = "/o/riverside/c/summer-league/d/new";
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));

const PASS_PRICE = formatMinor(passPrice("usd", "event_pass"), "usd"); // "$29"
// What a two-rung product may be quoted at on a surface offering no choice.
const FLOOR_USD = formatMinor(lowestPassRung("usd").amountMinor, "usd"); // "$29"
const FLOOR_GBP = formatMinor(lowestPassRung("gbp").amountMinor, "gbp"); // "£25"

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
    passKey = null,
    paidPlan = false,
    currency = "usd",
    lockReason = null,
    provider = passKey !== null || paidPlan || lockReason !== null,
  }: {
    passKey?: PassKey | null;
    paidPlan?: boolean;
    currency?: Currency;
    lockReason?: PassLockReason | null;
    provider?: boolean;
  } = {},
) {
  return renderToStaticMarkup(
    provider ? (
      <CompetitionPassProvider
        passKey={passKey}
        paidPlan={paidPlan}
        currency={currency}
        lockReason={lockReason}
      >
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

// v17 #294. This card is the paywall AND the main inbound link to the upgrade
// page, where the buyer is asked to choose between a $29 M and a $59 L. It
// quoted M's price flat, as though that were the price of the product — and it
// quoted it in hardcoded usd to every reader on earth.
describe("UpgradeGate — the pass price it quotes", () => {
  it("quotes the ladder's floor as a 'from' price, not one rung as the price", () => {
    pathname = "/o/riverside/c/summer-league/d/new";
    const html = render(<UpgradeGate feature={LIFTABLE} />, { passKey: null, provider: true });
    const cta = html.slice(html.indexOf("data-pass-cta"));
    expect(cta).toContain(FLOOR_USD);
    // The word matters as much as the number: without it the card states a
    // single price for a product that sells at two, which is the mis-sale.
    expect(cta).toMatch(/from/i);
  });

  it("prices in the currency the org is CHARGED in, not in hardcoded usd", () => {
    // `preferredCurrency` is a server resolution and this is a client island,
    // so the layout hands it down through the pass provider. Before that this
    // line read `passPrice("usd", …)` — a £-paying organiser was quoted $29
    // for a pass Stripe would charge them £25 for.
    pathname = "/o/riverside/c/summer-league/d/new";
    const html = render(<UpgradeGate feature={LIFTABLE} />, {
      passKey: null,
      provider: true,
      currency: "gbp",
    });
    expect(html).toContain(FLOOR_GBP);
    expect(html).not.toContain(FLOOR_USD);
  });

  it("prices the Pro path in that same currency", () => {
    // One card, one currency. A pass in £ beside "Go Pro — $19/mo" is worse
    // than the hardcoded usd it replaced.
    pathname = "/o/riverside/c/summer-league/d/new";
    const html = render(<UpgradeGate feature={LIFTABLE} />, {
      passKey: null,
      provider: true,
      currency: "gbp",
    });
    expect(html).not.toContain("$");
    expect(html).toContain("£");
  });

  it("still quotes usd on an org-level page, where no provider resolves one", () => {
    // The pass CTA cannot render without a competition, but the Pro price on
    // the paid-plan/owned cards can — and outside a provider that must be
    // exactly what it has always been.
    pathname = "/o/riverside/settings/billing";
    const html = render(<UpgradeGate feature={LIFTABLE} />);
    expect(html).not.toContain("£");
  });
});

describe("UpgradeGate — pass held (D1: never re-sell a pass the org holds)", () => {
  it("drops the $29 CTA at the pass's own ceiling", () => {
    // divisions.per_competition.max IS lifted by the pass (2 → 10). Seeing
    // this gate with a pass active means all 10 are used: another $29 buys
    // nothing, and Pro is the only real answer.
    pathname = "/o/riverside/c/summer-league/d/new";
    const html = render(<UpgradeGate feature={LIFTABLE} />, { passKey: "event_pass" });
    expect(html).not.toContain(UPGRADE_HREF);
    expect(html).not.toContain(PASS_PRICE);
    expect(html).not.toContain("data-pass-gate");
    expect(html).toContain("data-pass-owned");
    expect(html).toContain("/settings/billing");
  });

  it("names the RUNG that is held, on the card that explains its ceiling", () => {
    // v17 #294. This card's whole argument is "you've used everything the
    // Event Pass includes here" — and WHICH ceiling that is depends entirely
    // on which rung was bought (10 divisions/128 entrants, or 20/unlimited).
    // Both arms, so a card hardcoded the other way fails too.
    pathname = "/o/riverside/c/summer-league/d/new";
    const dict = uiEn as unknown as Dict;

    const l = render(<UpgradeGate feature={LIFTABLE} />, { passKey: "event_pass_l" });
    expect(l).toContain(passActiveLabel(dict, "event_pass_l"));
    expect(l).not.toContain(passActiveLabel(dict, "event_pass"));

    const m = render(<UpgradeGate feature={LIFTABLE} />, { passKey: "event_pass" });
    expect(m).toContain(passActiveLabel(dict, "event_pass"));
    expect(m).not.toContain(passActiveLabel(dict, "event_pass_l"));
  });

  it("leaves no un-substituted placeholder in that signal", () => {
    pathname = "/o/riverside/c/summer-league/d/new";
    expect(render(<UpgradeGate feature={LIFTABLE} />, { passKey: "event_pass_l" })).not.toContain(
      "{rung}",
    );
  });

  it("credits the pass already bought, within the window the credit code honours", () => {
    // server/usecases/pass-credit.ts: a pass BOUGHT (non-null payment intent)
    // within PASS_CREDIT_WINDOW_DAYS=30 is credited in full. The copy must
    // stay conditional on both, or it promises what the code refuses.
    pathname = "/o/riverside/c/summer-league/d/new";
    const html = render(<UpgradeGate feature={LIFTABLE} />, { passKey: "event_pass" });
    expect(html).toMatch(/bought in the last 30 days/i);
    expect(html).toMatch(/first Pro invoice/i);
  });

  it("pins the credit line to the upgrade.credit dict key, not a duplicated literal", () => {
    // design doc 2026-07-26 §6: creditLine must read the SAME key as the
    // upgrade page's `upgrade.credit`, not drift as a second hand-copied
    // string. Computing `expected` from the real en dict at test time — via
    // the same t()/interpolation the component itself uses — is what makes
    // this catch a wording change, a typo'd key, AND a revert to a hardcoded
    // string; a test that re-typed today's English sentence would only catch
    // the first of those three.
    pathname = "/o/riverside/c/summer-league/d/new";
    const dict = uiEn as unknown as Dict;
    const expected = t(dict, "upgrade.credit", { plan: "Pro" });
    const html = renderToStaticMarkup(
      <DictProvider dict={dict} locale="en">
        <CompetitionPassProvider passKey="event_pass" paidPlan={false}>
          <UpgradeGate feature={LIFTABLE} />
        </CompetitionPassProvider>
      </DictProvider>,
    );
    expect(html).toContain(expected);
  });

  it("says the feature is not on the pass when the pass could never lift it", () => {
    pathname = "/o/riverside/c/summer-league/schedule";
    const html = render(<UpgradeGate feature={NOT_LIFTABLE} />, { passKey: "event_pass" });
    expect(html).toContain("data-pass-owned");
    expect(html).toMatch(/not included in the Event Pass/i);
    expect(html).not.toContain(PASS_PRICE);
  });

  it("distinguishes the ceiling from a feature the pass never covered", () => {
    // Both are Pro-only cards; the two must not collapse into one message.
    // "You've used everything the pass gives" and "the pass never gave this"
    // are different sales conversations.
    pathname = "/o/riverside/c/summer-league/d/new";
    const ceiling = render(<UpgradeGate feature={LIFTABLE} />, { passKey: "event_pass" });
    const outside = render(<UpgradeGate feature={NOT_LIFTABLE} />, { passKey: "event_pass" });
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
      const html = render(<UpgradeGate feature={feature} />, { passKey: "event_pass" });
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
    const html = render(<UpgradeGate feature="officials.auto" />, { passKey: "event_pass" });
    expect(html).toContain("Go Pro Plus");
    expect(html).not.toMatch(/Go Pro —/);
  });

  it("sends the compact pill to billing, not to a second checkout", () => {
    // The toolbar pill is one link with no room for two paths; with a pass
    // held it must not be the $29 one.
    pathname = "/o/riverside/c/summer-league/d/main/schedule";
    const html = render(<UpgradeGate feature={LIFTABLE} compact />, { passKey: "event_pass" });
    expect(html).not.toContain(UPGRADE_HREF);
    expect(html).toContain('href="/settings/billing"');
  });

  it("honours an explicit href for the Pro path", () => {
    pathname = "/o/riverside/c/summer-league/d/new";
    const html = render(<UpgradeGate feature={LIFTABLE} href="/settings/billing#plans" />, {
      passKey: "event_pass",
    });
    expect(html).toContain('href="/settings/billing#plans"');
  });
});

describe("UpgradeGate — pass ended (v17 gap #301: a locked pass is not 'active')", () => {
  // The row still exists, so `usePassActive()` is true and every pre-#301
  // surface read that as "the pass is on". The resolver disagrees: once
  // `passLockReason` returns a reason, org_has_feature has already dropped back
  // to Community caps for this competition. This gate was therefore telling a
  // blocked org that its pass was ACTIVE and that it had "used everything the
  // Event Pass includes here" — two false statements about money, on the one
  // screen where the org is deciding whether to spend more.
  const dictEn = uiEn as unknown as Dict;
  const ended = (reason: PassLockReason) => ({ passKey: "event_pass" as PassKey, lockReason: reason });

  it("does not say the pass is active, or that everything on it was used up", () => {
    pathname = "/o/riverside/c/summer-league/d/new";
    const html = render(<UpgradeGate feature={LIFTABLE} />, ended("terminal"));
    expect(html).not.toContain(passActiveLabel(dictEn, "event_pass"));
    expect(html).not.toContain(passActiveLabel(dictEn, "event_pass_l"));
    expect(html).not.toMatch(/used everything the Event Pass includes/i);
    expect(html).toContain("data-pass-ended");
    expect(html).not.toContain("data-pass-owned");
  });

  it("never re-offers the pass once ended, same as held", () => {
    // Decision #248 Q4: one pass per competition, forever. There is no second
    // sale to make here, so a price or a checkout link would be an offer the
    // product cannot honour.
    pathname = "/o/riverside/c/summer-league/d/new";
    const html = render(<UpgradeGate feature={LIFTABLE} />, ended("past_ends_on"));
    expect(html).not.toContain(UPGRADE_HREF);
    expect(html).not.toContain(PASS_PRICE);
    expect(html).not.toContain(FLOOR_USD);
    expect(html).not.toContain("data-pass-gate");
    expect(html).not.toContain("data-pass-cta");
  });

  it("still sends the reader to Pro — the only real path left", () => {
    pathname = "/o/riverside/c/summer-league/d/new";
    const html = render(<UpgradeGate feature={LIFTABLE} />, ended("terminal"));
    expect(html).toContain("/settings/billing");
  });

  it("names the terminal reason distinctly from past-ends-on", () => {
    // Both arms, against the dictionary rather than a re-typed English
    // sentence: this then catches a hardcoded literal, a typo'd key, AND a
    // wording change, where a copy of today's copy would catch only the last.
    // A card that hardcodes either arm fails the opposite assertion.
    pathname = "/o/riverside/c/summer-league/d/new";
    const terminalCopy = t(dictEn, PASS_LOCK_REASON_KEY.terminal);
    const pastEndsCopy = t(dictEn, PASS_LOCK_REASON_KEY.past_ends_on);
    expect(terminalCopy).not.toEqual(pastEndsCopy);

    const terminal = render(<UpgradeGate feature={LIFTABLE} />, ended("terminal"));
    expect(terminal).toContain(terminalCopy);
    expect(terminal).not.toContain(pastEndsCopy);

    const pastEnds = render(<UpgradeGate feature={LIFTABLE} />, ended("past_ends_on"));
    expect(pastEnds).toContain(pastEndsCopy);
    expect(pastEnds).not.toContain(terminalCopy);
  });

  it("reads both reasons through the shared Record, so a new one cannot go unhandled", () => {
    // The guard against the `=== "terminal" ? … : …` shape the first draft of
    // this card used: that ternary keeps compiling when a third reason joins
    // PASS_LOCK_REASONS and quietly renders the past-ends-on sentence for it.
    // Iterating the exported key set means every reason must produce its own
    // sentence, and a reason added upstream without copy fails here.
    pathname = "/o/riverside/c/summer-league/d/new";
    const seen = new Set<string>();
    for (const reason of Object.keys(PASS_LOCK_REASON_KEY) as PassLockReason[]) {
      const html = render(<UpgradeGate feature={LIFTABLE} />, ended(reason));
      const copy = t(dictEn, PASS_LOCK_REASON_KEY[reason]);
      expect(html).toContain(copy);
      expect(copy).not.toEqual("");
      seen.add(copy);
    }
    expect(seen.size).toBe(Object.keys(PASS_LOCK_REASON_KEY).length);
  });

  it("does not wear the console's 'this is on' eyebrow", () => {
    // .app-eyebrow is the floodlit lime-tick treatment the pass-HELD card
    // earns. On this card it would contradict the sentence beneath it, and a
    // reader scanning for state reads the badge before the prose.
    pathname = "/o/riverside/c/summer-league/d/new";
    const html = render(<UpgradeGate feature={LIFTABLE} />, ended("terminal"));
    expect(html).not.toContain("app-eyebrow");
  });

  it("marks the compact pill too, without changing its state-agnostic copy", () => {
    pathname = "/o/riverside/c/summer-league/d/main/schedule";
    const html = render(<UpgradeGate feature={LIFTABLE} compact />, ended("terminal"));
    expect(html).toContain("data-pass-ended");
    expect(html).toContain('href="/settings/billing"');
    expect(html).not.toContain(UPGRADE_HREF);
  });

  it("says the same for a feature the pass never lifted", () => {
    // The ended card explains the PASS's state, not the feature's, so it does
    // not branch on liftability the way the owned card does.
    pathname = "/o/riverside/c/summer-league/schedule";
    const html = render(<UpgradeGate feature={NOT_LIFTABLE} />, ended("terminal"));
    expect(html).toContain("data-pass-ended");
    expect(html).toContain(t(dictEn, PASS_LOCK_REASON_KEY.terminal));
  });

  it("paid_plan still beats an ended pass", () => {
    // usePassGateState decides precedence once. A paid org's gate was closed by
    // its PLAN, so explaining it with a dead pass would name the wrong limit.
    pathname = "/o/riverside/c/summer-league/d/new";
    const html = render(<UpgradeGate feature={LIFTABLE} />, {
      passKey: "event_pass",
      paidPlan: true,
      lockReason: "terminal",
    });
    expect(html).not.toContain("data-pass-ended");
    expect(html).not.toContain("data-pass-owned");
    expect(html).toContain("See plans &amp; upgrade");
  });

  it("stays 'none' when a lock reason arrives with no pass row", () => {
    // The provider checks passKey before lockReason precisely so a stray reason
    // cannot invent an ended pass for a competition that never had one — that
    // org must still be offered the pass it can genuinely buy.
    pathname = "/o/riverside/c/summer-league/d/new";
    const html = render(<UpgradeGate feature={LIFTABLE} />, { lockReason: "terminal" });
    expect(html).not.toContain("data-pass-ended");
    expect(html).toContain("data-pass-gate");
    expect(html).toContain(`href="${UPGRADE_HREF}"`);
  });

  it("quotes the Pro price in the org's own currency, not hardcoded usd", () => {
    // Same rule #294 established for the cards either side of this one: every
    // amount on a card uses the currency the org is actually charged in.
    pathname = "/o/riverside/c/summer-league/d/new";
    const html = render(<UpgradeGate feature={LIFTABLE} />, {
      ...ended("terminal"),
      currency: "gbp",
    });
    expect(html).toContain(formatMinor(proPrice("monthly", "gbp"), "gbp"));
    expect(html).not.toContain(formatMinor(proPrice("monthly", "usd"), "usd"));
  });
});

describe("UpgradeGate — paid plan (D1: any paid plan → Pro path only)", () => {
  // Every key the pass lifts is one a paid plan lifts FURTHER — that is why
  // lib/entitlements.ts applies the pass arm only when the resolved plan is
  // community. Selling the pass to a paid org therefore sells strictly less
  // than they hold: 64 entrants against Pro's 256.
  // (scheduling.ai.runs_per_division.max used to be a second such row — 10 AI
  // runs per division against Pro's 20 — retired in v17 Phase 2 Task 5, V322:
  // the credit wallet meters runs on every tier now, not a plan-graded count.)
  const DOWNGRADE_KEYS = [
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
      passKey: "event_pass",
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
    const html = render(<UpgradeGate feature={LIFTABLE} />, { passKey: "event_pass" });
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
