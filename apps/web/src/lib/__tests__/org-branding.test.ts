// Org branding blob merges (v3/10 #5): colors and sponsors share one jsonb
// column — the regression this pins is the wipe bug (writing one key used to
// replace the whole blob, deleting the other).
import { describe, expect, it } from "vitest";
import { brandingSponsors, mergeBrandColor, mergeSponsors } from "@/lib/org-branding";

describe("org branding merges", () => {
  const existing = {
    colors: { primary: "#1d4ed8" },
    sponsors: [{ name: "Acme", url: "https://acme.dev" }],
  };

  it("setting a color keeps the sponsors", () => {
    const next = mergeBrandColor(existing, "#0F766E");
    expect(next.colors).toEqual({ primary: "#0f766e" }); // lowercased
    expect(next.sponsors).toEqual(existing.sponsors);
  });

  it("clearing the color keeps the sponsors", () => {
    const next = mergeBrandColor(existing, null);
    expect(next.colors).toBeUndefined();
    expect(next.sponsors).toEqual(existing.sponsors);
  });

  it("replacing sponsors keeps the color", () => {
    const next = mergeSponsors(existing, [{ name: "Bolt", logo: "https://x/l.png" }]);
    expect(next.colors).toEqual({ primary: "#1d4ed8" });
    expect(next.sponsors).toEqual([{ name: "Bolt", logo: "https://x/l.png" }]);
  });

  it("an empty sponsor list removes the key entirely", () => {
    const next = mergeSponsors(existing, []);
    expect("sponsors" in next).toBe(false);
  });

  it("brandingSponsors reads defensively", () => {
    expect(brandingSponsors(null)).toEqual([]);
    expect(brandingSponsors({ sponsors: "junk" })).toEqual([]);
    expect(brandingSponsors({ sponsors: [{ name: "Acme" }, { nope: 1 }] })).toEqual([
      { name: "Acme" },
    ]);
  });
});
