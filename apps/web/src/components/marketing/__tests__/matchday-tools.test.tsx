import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MatchdayTools, AlsoInTheKit } from "../matchday-tools";
import { MotifDivider } from "../motif-divider";

describe("MatchdayTools", () => {
  it("renders the three product cards, scheduling links to /scheduling", () => {
    const html = renderToStaticMarkup(<MatchdayTools />);
    expect(html).toContain("Live scoring");
    expect(html).toContain("Standings");
    expect(html).toContain("Scheduling board");
    expect(html).toContain('href="/scheduling"');
  });
  it("kit row covers the remaining features", () => {
    const html = renderToStaticMarkup(<AlsoInTheKit />);
    for (const label of [
      "Registration &amp; entry fees",
      "Print &amp; slideshow",
      "Roles &amp; scorer seats",
      "Secure by default",
    ]) {
      expect(html).toContain(label);
    }
  });
});

describe("MotifDivider", () => {
  it("renders both motifs as decorative (aria-hidden)", () => {
    for (const kind of ["shuttle", "knight"] as const) {
      const html = renderToStaticMarkup(<MotifDivider kind={kind} />);
      expect(html).toContain('aria-hidden="true"');
      expect(html).toContain(kind === "shuttle" ? "mk-shuttle" : "mk-knight");
    }
  });
});
