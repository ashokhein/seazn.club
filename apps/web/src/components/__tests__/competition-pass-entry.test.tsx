// <CompetitionPassEntry> — the Event Pass, offered BEFORE the refusal
// (task 19, spec D3).
//
// The failure being fixed: `routes.competitionUpgrade` had exactly one inbound
// link in the whole app — the paywall in <UpgradeGate>. A community organiser
// could only discover the pass by first being blocked by a limit, which is the
// worst possible moment to meet a price.
//
// The two failures this must NOT reintroduce, both already paid for once:
//
//   paid_plan → the pass grants strictly LESS than any paid plan: Pro's matrix
//               is a superset of it at every key the pass lifts. Offering it
//               there sells a downgrade. That was live in the gate until
//               f70b8e52; a brand-new surface is exactly where it comes back.
//   held      → never re-sell a pass the org already owns. Presence is ROW
//               EXISTENCE, never payment: a staff-granted pass carries a null
//               `stripe_payment_intent` and is fully active.
//
// Rendered through react-dom/server, like competition-pass-provider.test.tsx:
// the suite runs in the node environment and this island has no effects.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CompetitionPassProvider } from "@/components/competition-pass-provider";
import { CompetitionPassEntry } from "@/components/competition-pass-entry";
import { passActiveLabels } from "@/lib/pass-ladder";
import type { PassKey } from "@/lib/currency";
import uiEn from "@/dictionaries/en/ui.json";

const HREF = "/o/riverside/c/summer-league/upgrade";
// "from" since v17 #294: two rungs are live and $29 is the ladder's FLOOR, not
// the price. The label the page builds is `pass.entry.buy`.
const BUY = "Event Pass — from $29 one-time";
// Built the way the pages build it, so a dictionary change reaches this file
// rather than a literal here going quietly stale.
const ACTIVE_LABELS = passActiveLabels(uiEn);
const ACTIVE = ACTIVE_LABELS.event_pass;

function render({
  passKey = null,
  paidPlan = false,
  canBuy = true,
}: { passKey?: PassKey | null; paidPlan?: boolean; canBuy?: boolean } = {}) {
  return renderToStaticMarkup(
    <CompetitionPassProvider passKey={passKey} paidPlan={paidPlan}>
      <CompetitionPassEntry
        href={HREF}
        buyLabel={BUY}
        activeLabels={ACTIVE_LABELS}
        canBuy={canBuy}
      />
    </CompetitionPassProvider>,
  );
}

describe("CompetitionPassEntry", () => {
  it("offers the pass to a community org that does not hold one", () => {
    const html = render();
    expect(html).toContain(`href="${HREF}"`);
    expect(html).toContain(BUY);
  });

  it("is a link into the competition's own upgrade page, not the billing page", () => {
    // The whole point of the task: a SECOND inbound link to
    // routes.competitionUpgrade. Sending the reader to /settings/billing would
    // land them on Pro — a subscription — which is not what the column offers.
    expect(render()).not.toContain("/settings/billing");
  });

  it("shows the active signal, and no price, once the org holds the pass", () => {
    const html = render({ passKey: "event_pass" });
    expect(html).toContain(ACTIVE);
    expect(html).not.toContain(HREF);
    expect(html).not.toContain("$29");
  });

  it("names the RUNG that is held, not the product family", () => {
    // v17 #294. This eyebrow is the only thing the competition's own chrome
    // says about its pass, so "Event Pass active" over an `event_pass_l` row
    // tells a $59 buyer they hold the $29 product. Both arms, because a card
    // hardcoded the other way would satisfy either one alone.
    const m = render({ passKey: "event_pass" });
    expect(m).toContain(ACTIVE_LABELS.event_pass);
    expect(m).not.toContain(ACTIVE_LABELS.event_pass_l);

    const l = render({ passKey: "event_pass_l" });
    expect(l).toContain(ACTIVE_LABELS.event_pass_l);
    expect(l).not.toContain(ACTIVE_LABELS.event_pass);
  });

  it("carries the rung as an attribute, not only as copy", () => {
    // Pinned to the KEY so a rename of the label cannot silently empty the
    // assertions above, and so e2e can assert the rung without matching prose.
    expect(render({ passKey: "event_pass_l" })).toContain('data-pass-held-rung="event_pass_l"');
    expect(render({ passKey: "event_pass" })).toContain('data-pass-held-rung="event_pass"');
  });

  it("leaves no un-substituted placeholder in the held signal", () => {
    // `t()` renders a forgotten interpolation var as the literal `{rung}`.
    expect(render({ passKey: "event_pass_l" })).not.toContain("{rung}");
  });

  it("still shows the active signal to a viewer who cannot buy", () => {
    // "This competition has a pass" is a fact about the competition, not an
    // invitation — a scorer looking at a passed competition should see it.
    const html = render({ passKey: "event_pass", canBuy: false });
    expect(html).toContain(ACTIVE);
  });

  it("renders NOTHING for an org already on a paid plan", () => {
    // A Pro org has no pass row, so a naive "is there a pass?" boolean reads
    // false here and the $29 CTA appears — selling less than they already hold.
    expect(render({ paidPlan: true })).toBe("");
  });

  it("renders nothing for a paid org that also happens to hold a pass", () => {
    // Bought a pass, then upgraded: the row survives. The resolver stops
    // consulting it, so advertising it would name the wrong reason anything
    // works. usePassGateState collapses this to paid_plan; so does this.
    expect(render({ passKey: "event_pass", paidPlan: true })).toBe("");
  });

  it("offers nothing to a viewer who cannot buy and holds no pass", () => {
    expect(render({ canBuy: false })).toBe("");
  });

  it("does not answer to the paywall's [data-pass-cta] selector", () => {
    // pricing-v3.spec.ts asserts `[data-pass-cta]` has count 0 under a
    // competition whose pass is held — the proof that the gate stopped
    // re-selling it. A discovery link wearing that attribute would break that
    // proof on any page where both render.
    expect(render()).not.toContain("data-pass-cta");
    expect(render()).toContain("data-pass-entry");
  });

  it("reads 'none' — and therefore offers the pass — with no provider above it", () => {
    // Nothing should mount this outside a competition, but if something does,
    // the safe default is today's behaviour, not a crash.
    const html = renderToStaticMarkup(
      <CompetitionPassEntry href={HREF} buyLabel={BUY} activeLabels={ACTIVE_LABELS} canBuy />,
    );
    expect(html).toContain(BUY);
  });
});
