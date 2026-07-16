import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MatchdayTools, AlsoInTheKit } from "../matchday-tools";
import { MotifDivider } from "../motif-divider";
import enMarketing from "@/dictionaries/en/marketing.json";
import frMarketing from "@/dictionaries/fr/marketing.json";
import type { Dict } from "@/lib/i18n-constants";

const en = enMarketing as unknown as Dict;
const fr = frMarketing as unknown as Dict;

describe("MatchdayTools", () => {
  it("renders the three product cards, scheduling links to /scheduling", () => {
    const html = renderToStaticMarkup(<MatchdayTools dict={en} />);
    expect(html).toContain("Live scoring");
    expect(html).toContain("Standings");
    expect(html).toContain("Scheduling board");
    expect(html).toContain('href="/scheduling"');
  });
  it("localizes the cards from the dict (French)", () => {
    const html = renderToStaticMarkup(<MatchdayTools dict={fr} />);
    expect(html).toContain("Score en direct");
    expect(html).toContain("Classements");
    expect(html).toContain("Tableau de planification");
    expect(html).not.toContain("Live scoring");
  });
  it("kit row covers the remaining features", () => {
    const html = renderToStaticMarkup(<AlsoInTheKit dict={en} />);
    for (const label of [
      "Registration &amp; entry fees",
      "Print &amp; slideshow",
      "Roles &amp; scorer seats",
      "Secure by default",
    ]) {
      expect(html).toContain(label);
    }
  });
  it("localizes the kit row from the dict (French)", () => {
    const html = renderToStaticMarkup(<AlsoInTheKit dict={fr} />);
    expect(html).toContain("Sécurisé par défaut");
    expect(html).toContain("Impression et diaporama");
    expect(html).not.toContain("Secure by default");
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
