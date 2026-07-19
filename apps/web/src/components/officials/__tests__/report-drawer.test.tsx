import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ReportBody, type MatchReport } from "@/components/officials/report-drawer";
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

const report = (over: Partial<MatchReport> = {}): MatchReport => ({
  id: "r1",
  fixtureOfficialId: "fo1",
  status: "submitted",
  body: "Tense game, one sending-off.",
  incidents: [],
  submittedAt: "2026-07-19T10:00:00Z",
  ...over,
});

describe("ReportBody (shared read-only renderer)", () => {
  it("renders the body text", () => {
    const html = render(<ReportBody report={report()} />);
    expect(html).toContain("Tense game, one sending-off.");
  });

  it("leads a red_card incident with the red card glyph, plain chip otherwise", () => {
    const html = render(
      <ReportBody
        report={report({
          incidents: [
            { kind: "red_card", person_id: "p1", note: "violent conduct in the 88th" },
            { kind: "injury", note: "keeper concussion" },
          ],
        })}
        personNames={{ p1: "J. Smith" }}
      />,
    );
    // SPEC-1 card glyph (red #ef4444) leads the red_card row.
    expect(html).toContain("#ef4444");
    expect(html).toContain("Red card");
    expect(html).toContain("J. Smith");
    expect(html).toContain("violent conduct in the 88th");
    // Non-card kinds carry a plain chip, not a card glyph.
    expect(html).toContain("Injury");
    expect(html).toContain("keeper concussion");
  });

  it("shows the no-notes placeholder when the body is empty", () => {
    const html = render(<ReportBody report={report({ body: "" })} />);
    expect(html).toContain("No notes.");
  });
});
