import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { EntityCard } from "@/components/ui/entity-card";

// design/fix-ui/02-console-org.md: the org-home / competition-detail card's
// "Next: Now: X vs Y · Court N · date" line stacked BOTH labels together
// (both "Next:" and "Now:" rendered at once) and both were hardcoded English
// regardless of locale. EntityCard now takes { text, live } and picks
// exactly one localized label.
const props = {
  href: "/o/acme/c/summer",
  name: "Summer League",
  chip: <span>chip</span>,
};

describe("EntityCard next-fixture line", () => {
  it("shows the live label (not the upcoming one) when the fixture is in play, in French", () => {
    const html = renderToStaticMarkup(
      <EntityCard {...props} locale="fr" next={{ text: "A vs B · Court 2", live: true }} />,
    );
    expect(html).toContain("En cours :");
    expect(html).not.toContain("Prochain :");
    // Neither raw English fallback leaks through.
    expect(html).not.toContain("Now:");
    expect(html).not.toContain("Next:");
  });

  it("shows the upcoming label (not the live one) when the fixture isn't in play yet, in French", () => {
    const html = renderToStaticMarkup(
      <EntityCard {...props} locale="fr" next={{ text: "A vs B · Court 2", live: false }} />,
    );
    expect(html).toContain("Prochain :");
    expect(html).not.toContain("En cours :");
  });

  it("never renders both labels stacked together", () => {
    for (const live of [true, false]) {
      const html = renderToStaticMarkup(
        <EntityCard {...props} locale="en" next={{ text: "A vs B", live }} />,
      );
      const hasNext = html.includes(">Next:<");
      const hasNow = html.includes(">Now:<");
      expect(hasNext && hasNow).toBe(false);
    }
  });

  it("falls back to the localized empty-state copy when there's no next fixture", () => {
    const html = renderToStaticMarkup(<EntityCard {...props} locale="fr" next={null} />);
    expect(html).toContain("Rien de planifié");
  });
});
