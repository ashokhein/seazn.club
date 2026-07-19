import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkBadge, formatAverage } from "@/components/officials/mark-badge";
import { MarksSummaryView } from "@/components/officials/marks-summary-block";
import { DictProvider } from "@/components/i18n/dict-provider";
import uiEn from "@/dictionaries/en/ui.json";
import type { Dict } from "@/lib/i18n-constants";

const dict = uiEn as unknown as Dict;
const render = (node: React.ReactNode) =>
  renderToStaticMarkup(
    <DictProvider dict={dict} locale="en">
      {node}
    </DictProvider>,
  );

describe("formatAverage", () => {
  it("renders one decimal (scorebug numeral)", () => {
    expect(formatAverage(4.17)).toBe("4.2");
    expect(formatAverage(5)).toBe("5.0");
    expect(formatAverage(3)).toBe("3.0");
  });
});

describe("MarkBadge (scorebug chip)", () => {
  it("shows the big average and the avg · n label", () => {
    const html = render(<MarkBadge average={4.17} count={17} />);
    expect(html).toContain("4.2");
    expect(html).toContain("avg · 17");
    expect(html).toContain('data-testid="mark-badge"');
  });
});

describe("MarksSummaryView (org profile block)", () => {
  it("lists recent comments with their fixture labels + the average badge", () => {
    const html = render(
      <MarksSummaryView
        summary={{
          average: 4,
          count: 3,
          recent: [
            { mark: 5, comment: "Excellent control", fixtureLabel: "Rovers vs City", createdAt: "x" },
          ],
        }}
      />,
    );
    expect(html).toContain("4.0"); // badge
    expect(html).toContain("Rovers vs City");
    expect(html).toContain("Excellent control");
  });

  it("renders the empty state when there are no marks", () => {
    const html = render(<MarksSummaryView summary={{ average: null, count: 0, recent: [] }} />);
    expect(html).toContain("No marks yet.");
  });
});
