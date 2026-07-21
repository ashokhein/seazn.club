// <BillingPassOffer> — the Event Pass on the billing page (task 19, spec D3).
//
// Billing is where an org reads "5 / 5 active competitions" and goes looking
// for the next tier. Before this, the only thing on that page was Pro at
// $19/mo; the $29 one-time pass — which buys a competition OUT of that very
// meter — was not mentioned, and could not have been linked to anyway without
// naming a competition.
//
// So the section is a list of competitions, each linking to its own
// `routes.competitionUpgrade`. That is the contract these tests pin: real
// per-competition hrefs, and an empty render when there is nothing to sell.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BillingPassOffer } from "@/components/billing-pass-offer";
import enUi from "@/dictionaries/en/ui.json";

const ROWS = [
  { id: "c1", name: "Summer League", slug: "summer-league" },
  { id: "c2", name: "Winter Cup", slug: "winter-cup" },
];

const render = (rows: typeof ROWS) =>
  renderToStaticMarkup(
    <BillingPassOffer rows={rows} orgSlug="riverside" price="$29" dict={enUi} />,
  );

describe("BillingPassOffer", () => {
  it("links each competition to its own upgrade page", () => {
    const html = render(ROWS);
    expect(html).toContain('href="/o/riverside/c/summer-league/upgrade"');
    expect(html).toContain('href="/o/riverside/c/winter-cup/upgrade"');
  });

  it("names the competition the pass would be bought for", () => {
    // A bare "buy a pass" button cannot work: the pass is bought FOR a
    // competition, so the choice has to be on the page.
    const html = render(ROWS);
    expect(html).toContain("Summer League");
    expect(html).toContain("Winter Cup");
  });

  it("states the one-time price", () => {
    expect(render(ROWS)).toContain("$29");
  });

  it("renders nothing when the org has no competition to pass", () => {
    // An org with no competitions has nothing to buy a pass for; an empty card
    // on every such billing page would be noise.
    expect(render([])).toBe("");
  });

  it("carries a stable hook for the surface", () => {
    expect(render(ROWS)).toContain("data-pass-offer");
  });
});
