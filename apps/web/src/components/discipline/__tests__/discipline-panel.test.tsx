import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, replace: () => {}, push: () => {} }),
  usePathname: () => "/",
}));

import { DisciplinePanel } from "@/components/discipline/discipline-panel";
import { DictProvider } from "@/components/i18n/dict-provider";
import uiEn from "@/dictionaries/en/ui.json";
import type { Dict } from "@/lib/i18n-constants";
import type { Suspension } from "@/server/usecases/discipline";

const dict = uiEn as unknown as Dict;

function sus(over: Partial<Suspension>): Suspension {
  return {
    id: "s1",
    divisionId: "d1",
    personId: "p1",
    personName: "J. Smith",
    entrantId: "e1",
    entrantName: "Rovers",
    status: "pending",
    source: "auto_dismissal",
    reason: "Red card",
    matchesTotal: 2,
    matchesServed: 0,
    fixtureId: null,
    createdAt: "2026-07-18T00:00:00Z",
    decidedAt: null,
    triggerVoided: false,
    ...over,
  };
}

function render(items: Suspension[]): string {
  return renderToStaticMarkup(
    <DictProvider dict={dict} locale="en">
      <DisciplinePanel
        divisionId="d1"
        initial={items}
        squad={[{ person_id: "p9", full_name: "K. Doe" }]}
        canEdit
      />
    </DictProvider>,
  );
}

describe("DisciplinePanel", () => {
  it("shows a pending row with confirm + waive and the person's name", () => {
    const html = render([sus({ id: "s1", status: "pending" })]);
    expect(html).toContain("J. Smith");
    expect(html).toContain("Confirm");
    expect(html).toContain("Waive");
    expect(html).toContain('data-testid="pending-row"');
  });

  it("renders the trigger-voided hint chip when the trigger card was voided", () => {
    const html = render([sus({ status: "pending", triggerVoided: true })]);
    expect(html).toContain("trigger card was voided");
  });

  it("shows served pips on an active ban", () => {
    const html = render([sus({ id: "a1", status: "active", matchesServed: 1, matchesTotal: 2 })]);
    expect(html).toContain('data-testid="active-row"');
    expect(html).toContain("1 of 2 matches served");
  });

  it("collects served/waived rows into the history disclosure", () => {
    const html = render([
      sus({ id: "h1", status: "served" }),
      sus({ id: "h2", status: "waived" }),
    ]);
    expect(html).toContain("Served");
    expect(html).toContain("Waived");
  });

  it("offers the manual record form over the division squad", () => {
    const html = render([]);
    expect(html).toContain('data-testid="record-form"');
    expect(html).toContain("K. Doe");
  });

  it("tags a report-sourced pending row with a From-match-report chip + view link", () => {
    const html = render([
      sus({ id: "rp1", status: "pending", source: "report", fixtureId: "fx1", reason: "violent conduct" }),
    ]);
    expect(html).toContain("From match report");
    expect(html).toContain("View report");
  });

  it("does not tag non-report sources", () => {
    const html = render([sus({ status: "pending", source: "auto_dismissal", fixtureId: "fx1" })]);
    expect(html).not.toContain("From match report");
  });
});
