import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// #403 finding 2, box 4: the scheduling name guard (#396) infers that two
// `persons` rows are one human from normalised-name equality. It is not Art. 22
// ADM — the effect is which time a match is played — but it IS a processing
// activity the data subject cannot otherwise know about, so the privacy page
// has to describe it. The mitigations it claims (non-persisted,
// scheduling-scoped, disclosed in `assumptions`) are enforced elsewhere:
// personKeyResolver (server/usecases/schedule-ai.ts:173) and its pack test
// "…one participant key, persons untouched".
vi.mock("@/components/marketing-nav", () => ({ MarketingNav: () => null }));
vi.mock("@/components/marketing-footer", () => ({ MarketingFooter: () => null }));

import PrivacyPage from "../privacy/page";
import { LEGAL_VERSION } from "@/lib/legal";

const html = renderToStaticMarkup(<PrivacyPage />);

describe("privacy page — scheduling grouping disclosure (#403)", () => {
  it("describes automatic same-name grouping for scheduling", () => {
    expect(html).toContain("treated as one player while a timetable is built");
  });

  it("states that no records are merged and nothing is written", () => {
    expect(html).toContain("No records are merged");
    expect(html).toContain("nothing is written to them");
  });

  it("says the grouping is shown back to the organiser before it is applied", () => {
    expect(html).toContain("listed back to the organiser");
  });

  it("says it is not Article 22 automated decision-making", () => {
    expect(html).toContain("not automated decision-making under Article 22");
  });

  it("states a retention period for stored scheduling instructions", () => {
    // ai_parse_previews stores the organiser's raw free-text instruction, which
    // can carry personal data. The sweep that enforces this is
    // server/usecases/ai-preview-sweep.ts.
    expect(html).toContain("deleted within the hour");
    expect(html).toContain("kept for 30 days");
  });

  it("carries the LEGAL_VERSION date as its Last updated line", () => {
    // Guards the drift that makes a consent stamp meaningless: the page text
    // moves but the version users are recorded as having accepted does not.
    const [y, m, d] = LEGAL_VERSION.split("-").map(Number);
    const shown = new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    });
    expect(html).toContain(`Last updated: ${shown}`);
  });

  it("numbers its sections 1..12 with no repeat or gap", () => {
    const numbers = [...html.matchAll(/<h2[^>]*>(\d+)\./g)].map((m) => Number(m[1]));
    expect(numbers).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
  });
});
