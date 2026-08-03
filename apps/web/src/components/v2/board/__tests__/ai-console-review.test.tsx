// W5 (#400, #388) — the single-division console's schedule step must SAY the
// two things a finished run has always known and never mentioned: the fixtures
// the solver gave up on, and the architect's own assumptions about the
// sentence. Until this task both arrived in the response and went nowhere, so
// an organiser reading a clean-looking board had no way to learn that three
// matches were quietly left in the tray.
//
// Assertions anchor on `="`: React serialises an omitted prop as
// `"$undefined"`, so a bare `data-review-count` probe passes in both states.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Dict } from "@/lib/i18n-constants";
import { DictProvider } from "@/components/i18n/dict-provider";
import { ScheduleStep } from "../ai-console";
import { initialAiConsoleState, type AiConsoleState } from "../ai-console-state";
import type { AiConsoleFixture } from "../ai-diff";
import type { AiPlanResponse } from "@/server/api-v1/schemas";
import en from "@/dictionaries/en/ui.json";

const enDict = en as Record<string, string>;

const F1 = "11111111-1111-1111-1111-111111111111";
const F2 = "22222222-2222-2222-2222-222222222222";

const fixtures: AiConsoleFixture[] = [F1, F2].map((id, i) => ({
  id,
  stage_id: "st-1",
  scheduled_at: null,
  court_label: null,
  code: `R1·${i + 1}`,
  matchup: i === 0 ? "Ackerman vs Bright" : "Castellano vs Devi",
  isFinal: false,
  isJunior: false,
  status: "scheduled",
  home_entrant_id: `en-${i}a`,
  away_entrant_id: `en-${i}b`,
}));

const basePlan = (over: Partial<AiPlanResponse> = {}): AiPlanResponse =>
  ({
    proposal: [
      { fixture_id: F1, scheduled_at: "2026-08-01T09:00:00.000Z", court_label: "Court 1" },
    ],
    unschedulable: [],
    warnings: [],
    blocking: [],
    assumptions: [],
    diff: { moved: [], placed: [F1], unscheduled: [], unchanged: [] },
    explanations: [],
    summary: "Placed one match.",
    usage: { input_tokens: 10, output_tokens: 20, repair_rounds: 0 },
    credits: 1,
    ...over,
  }) as unknown as AiPlanResponse;

function schedule(plan: AiPlanResponse): string {
  const state: AiConsoleState = { ...initialAiConsoleState, step: "schedule", schedulePlan: plan };
  return renderToStaticMarkup(
    <DictProvider dict={enDict as unknown as Dict} locale="en">
      <ScheduleStep
        state={state}
        dispatch={() => {}}
        msg={(k, v) => format(k as string, v as Record<string, string | number> | undefined)}
        fixtures={fixtures}
        courts={2}
        busy={false}
        traceNonce={0}
        onPulse={() => {}}
      />
    </DictProvider>,
  );
}

/** The step takes `msg` as a prop; resolve against the real en dictionary so a
 *  missing key shows up as the key itself rather than silently passing. */
function format(key: string, vars?: Record<string, string | number>): string {
  const raw = enDict[key] ?? key;
  return vars ? raw.replace(/\{(\w+)\}/g, (m, n: string) => (n in vars ? String(vars[n]) : m)) : raw;
}

describe("ScheduleStep — the review card", () => {
  it("renders unschedulable fixtures and assumptions after a run", () => {
    const html = schedule(
      basePlan({
        unschedulable: [{ fixture_id: F2, reason: "no court free in the window", rule: "CAP" }],
        assumptions: ["Read 'the weekend' as Sat + Sun."],
      } as Partial<AiPlanResponse>),
    );
    expect(html).toContain('data-review-count="2"');
    expect(html).toContain("no court free in the window");
    expect(html).toContain("Read &#x27;the weekend&#x27; as Sat + Sun.");
    // The fixture is named, not just counted — "one match was left out" without
    // saying which is a sentence an organiser cannot act on.
    expect(html).toContain("Castellano vs Devi");
    expect(html).toContain(enDict["board.ai.review.unschedulable"]!);
  });

  it("counts warnings, unschedulable and assumptions as one number", () => {
    const html = schedule(
      basePlan({
        warnings: [{ fixtureId: F1, reason: "person_overlap", detail: "Ali Khan" }],
        unschedulable: [{ fixture_id: F2, reason: "no court free in the window", rule: "CAP" }],
        assumptions: ["Read 'the weekend' as Sat + Sun."],
      } as Partial<AiPlanResponse>),
    );
    expect(html).toContain('data-review-count="3"');
    expect(html.match(/data-review-count="/g) ?? []).toHaveLength(1);
  });

  it("shows no review card at all for a clean plan", () => {
    const html = schedule(basePlan());
    expect(html).not.toContain('data-review-count="');
    // …but the step itself still rendered, so the absence means "nothing to
    // review", not "nothing rendered".
    expect(html).toContain(enDict["board.ai.schedule.reviewNote"]!);
  });

  it("keeps the card above the review note, where the eye lands before the buttons", () => {
    const html = schedule(
      basePlan({ assumptions: ["Read 'the weekend' as Sat + Sun."] } as Partial<AiPlanResponse>),
    );
    expect(html.indexOf('data-review-count="')).toBeLessThan(
      html.indexOf(enDict["board.ai.schedule.reviewNote"]!),
    );
  });

  it("offers the grid pulse, because the step has one wired", () => {
    const html = schedule(
      basePlan({ warnings: [{ fixtureId: F1, reason: "rest", detail: "20 minutes" }] } as Partial<AiPlanResponse>),
    );
    expect(html).toContain('data-review-pulse="1"');
  });
});
