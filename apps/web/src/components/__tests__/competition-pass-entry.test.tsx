// <CompetitionPassEntry> — the Event Pass, offered BEFORE the refusal
// (task 19, spec D3).
//
// The failure being fixed: `routes.competitionUpgrade` had exactly one inbound
// link in the whole app — the paywall in <UpgradeGate>. A community organiser
// could only discover the $29 pass by first being blocked by a limit, which is
// the worst possible moment to meet a price.
//
// The two failures this must NOT reintroduce, both already paid for once:
//
//   paid_plan → the $29 pass grants strictly LESS than any paid plan (10 AI
//               runs per division against pro's 20, 64 entrants per division
//               against pro's 256). Offering it there sells a downgrade. That
//               was live in the gate until f70b8e52; a brand-new surface is
//               exactly where it comes back.
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

const HREF = "/o/riverside/c/summer-league/upgrade";
const BUY = "Event Pass — $29 one-time";
const ACTIVE = "Event Pass active";

function render({
  passActive = false,
  paidPlan = false,
  canBuy = true,
}: { passActive?: boolean; paidPlan?: boolean; canBuy?: boolean } = {}) {
  return renderToStaticMarkup(
    <CompetitionPassProvider active={passActive} paidPlan={paidPlan}>
      <CompetitionPassEntry href={HREF} buyLabel={BUY} activeLabel={ACTIVE} canBuy={canBuy} />
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
    const html = render({ passActive: true });
    expect(html).toContain(ACTIVE);
    expect(html).not.toContain(HREF);
    expect(html).not.toContain("$29");
  });

  it("still shows the active signal to a viewer who cannot buy", () => {
    // "This competition has a pass" is a fact about the competition, not an
    // invitation — a scorer looking at a passed competition should see it.
    const html = render({ passActive: true, canBuy: false });
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
    expect(render({ passActive: true, paidPlan: true })).toBe("");
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
      <CompetitionPassEntry href={HREF} buyLabel={BUY} activeLabel={ACTIVE} canBuy />,
    );
    expect(html).toContain(BUY);
  });
});
