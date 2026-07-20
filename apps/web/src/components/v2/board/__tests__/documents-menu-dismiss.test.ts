import { describe, expect, it } from "vitest";
import { dismissesMenu } from "@/components/v2/board/documents-menu";

// Regression: the Documents menu was a bare <details>, which only ever toggles
// from its own <summary>. Clicking anywhere else left the panel open on top of
// the fixtures list — you had to travel back to the trigger to shut it.
//
// vitest runs environment "node" here with no jsdom, so the effect that wires
// this up cannot be exercised; the rule it applies is what gets pinned.
function root(open: boolean, inside: Node[]): { open: boolean; contains: (n: Node) => boolean } {
  return { open, contains: (n) => inside.includes(n) };
}
const summary = {} as Node;
const elsewhere = {} as Node;

describe("dismissesMenu", () => {
  it("closes when the pointer lands outside an open menu", () => {
    expect(dismissesMenu(root(true, [summary]), elsewhere)).toBe(true);
  });

  it("leaves the menu alone when the pointer is inside it", () => {
    // Otherwise the panel would shut before a download button's click landed.
    expect(dismissesMenu(root(true, [summary]), summary)).toBe(false);
  });

  it("does nothing when the menu is already closed", () => {
    // Every outside click on the page would otherwise do pointless work.
    expect(dismissesMenu(root(false, [summary]), elsewhere)).toBe(false);
  });

  it("tolerates a null ref, which is what it holds before mount", () => {
    expect(dismissesMenu(null, elsewhere)).toBe(false);
  });
});
