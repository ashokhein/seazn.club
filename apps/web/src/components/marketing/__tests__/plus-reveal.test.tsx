import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PlusReveal } from "../plus-reveal";

// Node-env render contract (repo has no jsdom): Pro Plus is progressively
// disclosed (spec §4) — the initial server markup must show only the teaser
// + reveal CTA, never the Pro Plus card itself, so there's no flash of the
// fourth offer before a visitor asks for it.
const { track } = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("@/lib/analytics", () => ({ track }));

describe("PlusReveal", () => {
  it("starts hidden: renders the teaser + CTA, not the children", () => {
    const html = renderToStaticMarkup(
      <PlusReveal teaser="Need more scale?" cta="Show Pro Plus">
        <div data-plus-card>Pro Plus card</div>
      </PlusReveal>,
    );
    expect(html).toContain("Need more scale?");
    expect(html).toContain("Show Pro Plus");
    expect(html).toContain("data-plus-reveal-cta");
    expect(html).not.toContain("data-plus-revealed");
    expect(html).not.toContain("data-plus-card");
  });
});
