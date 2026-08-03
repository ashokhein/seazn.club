// W5 (#400, #388). The shared review panel: every amber row the run produced —
// warnings, fixtures the solver gave up on, and the architect's own assumptions
// — in one card, with the count taken from the array it renders.
//
// Assertions on the rendered body anchor on `="`. React serialises an omitted
// prop as `"$undefined"`, so a bare `data-review-count` probe passes even when
// the attribute was never set.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Dict, Locale } from "@/lib/i18n-constants";
import { DictProvider } from "@/components/i18n/dict-provider";
import { AiReviewPanel } from "../ai-review-panel";
import { buildReviewRows, type ReviewSource } from "../ai-review";
import type { AiConsoleFixture } from "../ai-diff";
import en from "@/dictionaries/en/ui.json";
import fr from "@/dictionaries/fr/ui.json";

const enDict = en as Record<string, string>;
const frDict = fr as Record<string, string>;

const F1 = "11111111-1111-1111-1111-111111111111";
const F2 = "22222222-2222-2222-2222-222222222222";

// `person_overlap`, not `rest`: `board.conflict.warn.rest` is literally the
// string "rest", identical to the engine's own token, so an implementation that
// rendered `row.reason` raw would satisfy a localization assertion made against
// it. "person overlap" ≠ "person_overlap", so the assertion has teeth.
const source: ReviewSource = {
  warnings: [{ fixtureId: F1, reason: "person_overlap", detail: "18 min short of 45" }],
  unschedulable: [{ fixture_id: F2, reason: "no court free in the window", rule: "CAP" }],
  assumptions: ["Read 'the weekend' as Sat + Sun."],
};
const rows = buildReviewRows(source);

const fixtures: AiConsoleFixture[] = [
  {
    id: F1,
    stage_id: "st-1",
    scheduled_at: null,
    court_label: null,
    code: "SF1",
    matchup: "Ackerman vs Bright",
    isFinal: false,
    isJunior: false,
    status: "scheduled",
    home_entrant_id: "en-a",
    away_entrant_id: "en-b",
  },
  {
    id: F2,
    stage_id: "st-1",
    scheduled_at: null,
    court_label: null,
    code: "QF3",
    matchup: "Castellano vs Devi",
    isFinal: true,
    isJunior: false,
    status: "scheduled",
    home_entrant_id: "en-c",
    away_entrant_id: "en-d",
  },
];

function render(
  node: React.ReactElement,
  dict: Record<string, string> = enDict,
  locale: Locale = "en",
): string {
  return renderToStaticMarkup(
    <DictProvider dict={dict as unknown as Dict} locale={locale}>
      {node}
    </DictProvider>,
  );
}

describe("AiReviewPanel", () => {
  it("renders every row category and states the count once", () => {
    const html = render(<AiReviewPanel rows={rows} fixtures={fixtures} />);
    expect(html).toContain('data-review-count="3"');
    expect(html).toContain("18 min short of 45");
    expect(html).toContain("no court free in the window");
    expect(html).toContain("Read &#x27;the weekend&#x27; as Sat + Sun.");
    // One count, stated once — the header number is the array length.
    expect(html.match(/data-review-count="/g) ?? []).toHaveLength(1);
  });

  it("names the matchup and code of the fixture each finding is about", () => {
    const html = render(<AiReviewPanel rows={rows} fixtures={fixtures} />);
    expect(html).toContain("SF1");
    expect(html).toContain("Ackerman vs Bright");
    expect(html).toContain("QF3");
    expect(html).toContain("Castellano vs Devi");
  });

  it("localizes the warning reason through the shared conflict taxonomy", () => {
    // The engine hands us the raw camelCase token `rest`. Rendering it would
    // leak English into fr/es/nl — the diff panel's own regression (#N/A, v4
    // Task 13 review) reproduced on a new surface.
    const key = "board.conflict.warn.person_overlap";
    // The label must differ from the raw token, or rendering `row.reason`
    // untouched would pass this test in every locale.
    expect(enDict[key]).not.toBe("person_overlap");

    const enHtml = render(<AiReviewPanel rows={rows} fixtures={fixtures} />);
    expect(enHtml).toContain(enDict[key]!);
    expect(enHtml).not.toContain("person_overlap");

    const frHtml = render(<AiReviewPanel rows={rows} fixtures={fixtures} />, frDict, "fr");
    expect(frDict[key]).not.toBe(enDict[key]);
    expect(frHtml).toContain(frDict[key]!);
  });

  it("says what happens to an unschedulable fixture, and names the rule", () => {
    const html = render(<AiReviewPanel rows={rows} fixtures={fixtures} />);
    expect(html).toContain(enDict["board.ai.review.unschedulable"]!);
    expect(html).toContain(">CAP<");
  });

  it("carries the division chip on the joint console and omits it when unknown", () => {
    const html = render(
      <AiReviewPanel
        rows={rows}
        fixtures={fixtures}
        divisionFor={(id) => (id === F2 ? { id: "d1", name: "Under 16s Singles" } : null)}
      />,
    );
    expect(html).toContain("Under 16s Singles");
    // Never guessed for F1: exactly one chip, on the row whose division we know.
    expect(html.match(/data-division-chip="/g) ?? []).toHaveLength(1);
  });

  it("renders no chip at all on the single-division console", () => {
    const html = render(<AiReviewPanel rows={rows} fixtures={fixtures} />);
    expect(html.match(/data-division-chip="/g) ?? []).toHaveLength(0);
  });

  it("renders nothing at all for an empty row list", () => {
    const html = render(<AiReviewPanel rows={[]} fixtures={[]} />);
    expect(html).toBe("");
  });

  it("offers the grid pulse only when a handler is wired", () => {
    const withPulse = render(
      <AiReviewPanel rows={rows} fixtures={fixtures} onPulse={() => {}} />,
    );
    expect(withPulse).toContain('data-review-pulse="1"');
    expect(withPulse).toContain(enDict["board.ai.review.pulse.one"]!);

    const without = render(<AiReviewPanel rows={rows} fixtures={fixtures} />);
    expect(without).not.toContain('data-review-pulse="');
  });

  // Carried from the Task 5 review. The control is filtered to the rows that
  // have a grid block to light, so on a card holding three rows it lights ONE —
  // and "Show these on the board" said "these" about a subset and nothing about
  // which. The count is the fix: the label names what will actually flash, and
  // the header's own number stays what it always was.
  it("names how many fixtures the pulse will light, which is not the row count", () => {
    const html = render(<AiReviewPanel rows={rows} fixtures={fixtures} onPulse={() => {}} />);
    // Three rows to review; one of them is on the grid.
    expect(html).toContain('data-review-count="3"');
    expect(html).toContain(enDict["board.ai.review.pulse.one"]!);
    expect(html).not.toContain(enDict["board.ai.review.pulse.other"]!.replace("{count}", "3"));

    // Two warnings, two lit — the number tracks the filtered subset rather than
    // being frozen at one, which a hardcoded singular would also satisfy above.
    const twoFlagged = buildReviewRows({
      warnings: [
        { fixtureId: F1, reason: "person_overlap", detail: "18 min short of 45" },
        { fixtureId: F2, reason: "rest", detail: "20 minutes" },
      ],
      unschedulable: source.unschedulable,
      assumptions: source.assumptions,
    });
    const two = render(<AiReviewPanel rows={twoFlagged} fixtures={fixtures} onPulse={() => {}} />);
    expect(two).toContain('data-review-count="4"');
    expect(two).toContain(enDict["board.ai.review.pulse.other"]!.replace("{count}", "2"));
  });

  // Must-fix 3. "Show these on the board" has to point at something. An
  // unschedulable fixture is not on the grid — the card's own copy says it
  // stays in the tray — and an assumption is about no fixture at all, so a card
  // holding only those offers no pulse rather than a button that lights nothing.
  it("withholds the pulse when nothing on the card is on the grid", () => {
    const trayOnly = buildReviewRows({
      warnings: [],
      unschedulable: source.unschedulable,
      assumptions: source.assumptions,
    });
    const html = render(
      <AiReviewPanel rows={trayOnly} fixtures={fixtures} onPulse={() => {}} />,
    );
    // The card is still there — there are two things to review.
    expect(html).toContain('data-review-count="2"');
    expect(html).not.toContain('data-review-pulse="');
    expect(html).not.toContain(enDict["board.ai.review.pulse.one"]!);
    expect(html).not.toContain(enDict["board.ai.review.pulse.other"]!.replace("{count}", "2"));
  });

  it("falls back to a short id when the fixture is not on the board", () => {
    const html = render(<AiReviewPanel rows={rows} fixtures={[]} />);
    expect(html).toContain(F1.slice(0, 8));
  });

  // 375px: rows are flex, the matchup is the only thing allowed to shrink, and
  // chips/markers never do. A fixed width or a table here is what produces a
  // horizontally scrolling dock on a phone.
  it("keeps every row shrinkable at 375px", () => {
    const html = render(
      <AiReviewPanel
        rows={rows}
        fixtures={fixtures}
        divisionFor={() => ({ id: "d1", name: "Under 16s Singles" })}
      />,
    );
    expect(html).not.toContain("<table");
    const items = html.match(/<li[^>]*class="([^"]*)"/g) ?? [];
    expect(items).toHaveLength(3);
    for (const li of items) expect(li).toContain("flex items-start");
    // Both fixture rows, not "at least one somewhere" — a `toContain` here was
    // satisfied by a single element and said nothing about the other row.
    expect(html.match(/min-w-0 flex-1 truncate/g) ?? []).toHaveLength(2);
    // The rule chip must not be squeezed to nothing by a long matchup.
    expect(html).toMatch(/class="shrink-0[^"]*"[^>]*>CAP</);
  });
});
