// W6 (#401): the AI diff panel reports what the constraint solver repaired
// before the model was asked again.
//
// Four properties, each of which fails differently and silently if it regresses:
//
//   * The strip is absent when the solver did nothing. A status panel that fires
//     on every no-op stops being read, and then it fails to communicate on the
//     one run where it mattered.
//   * The minimality sentence appears ONLY on `proved`. The engine returns
//     `upper_bound` whenever a day cap couples components and deliberately
//     declines to claim minimality there; printing "no smaller change would have
//     worked" on an upper bound would be a lie the engine refused to tell.
//   * Leftovers for the model are shown. A repair that half-worked and says
//     nothing is worse than one that admits it.
//   * Nothing here is hardcoded English.
//
// Assertions anchor on `="` for the data-* probes. React serialises an omitted
// prop as `"$undefined"`, so a bare `data-moved` substring is present whether the
// attribute was set or not, and the test would pass in both states.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AiPlanResponse } from "@/server/api-v1/schemas";
import type { Dict, Locale } from "@/lib/i18n-constants";
import { DictProvider } from "@/components/i18n/dict-provider";
import { AiDiffPanel } from "../ai-diff-panel";
import type { AiConsoleFixture } from "../ai-diff";
import en from "@/dictionaries/en/ui.json";
import fr from "@/dictionaries/fr/ui.json";

const enDict = en as Record<string, string>;
const frDict = fr as Record<string, string>;

const FIX = "11111111-1111-1111-1111-111111111111";

const basePlan: AiPlanResponse = {
  proposal: [],
  unschedulable: [],
  warnings: [],
  blocking: [],
  diff: { moved: [], placed: [], unscheduled: [], unchanged: [] },
  explanations: [],
  summary: "Kept the court clear.",
  assumptions: [],
  usage: { input_tokens: 10, output_tokens: 5, repair_rounds: 0 },
  repair: { engine: "none" as const, solver_ran: false },
  officials_coverage: null,
};

const fixtures: AiConsoleFixture[] = [
  {
    id: FIX,
    stage_id: "st-1",
    scheduled_at: null,
    court_label: null,
    code: "SF1",
    matchup: "A vs B",
    isFinal: false,
    isJunior: false,
    status: "scheduled",
    home_entrant_id: "en-a",
    away_entrant_id: "en-b",
  },
];

function render(
  repair: AiPlanResponse["repair"],
  dict: Record<string, string> = enDict,
  locale: Locale = "en",
): string {
  return renderToStaticMarkup(
    <DictProvider dict={dict as unknown as Dict} locale={locale}>
      <AiDiffPanel
        plan={{ ...basePlan, repair }}
        fixtures={fixtures}
        excluded={[]}
        onToggleExclude={() => {}}
      />
    </DictProvider>,
  );
}

describe("AiDiffPanel repair strip", () => {
  it("says nothing when the solver never ran", () => {
    expect(render({ engine: "none", solver_ran: false })).not.toContain(
      'data-testid="ai-repair-strip"',
    );
  });

  it("says nothing when the solver ran and moved nothing", () => {
    // The clean path: the board verified, so there was no work to report. This
    // is the case that would turn the panel into noise on every single run.
    const html = render({ engine: "z3", solver_ran: true, status: "clean", moved: 0 });
    expect(html).not.toContain('data-testid="ai-repair-strip"');
  });

  it("reports the move count once the solver actually moved fixtures", () => {
    const html = render({ engine: "z3", solver_ran: true, status: "repaired", moved: 2 });
    expect(html).toContain('data-testid="ai-repair-strip"');
    expect(html).toContain('data-moved="2"');
    expect(html).toContain(enDict["board.ai.repaired.freeOfCharge"]!);
  });

  it("claims minimality only when the engine proved it", () => {
    const proved = render({
      engine: "z3",
      solver_ran: true,
      status: "repaired",
      moved: 2,
      minimality: "proved",
    });
    expect(proved).toContain('data-minimality="proved"');
    expect(proved).toContain(enDict["board.ai.repaired.minimal"]!);

    // Same repair, weaker guarantee. `upper_bound` means "the fewest this
    // decomposition found", not "the fewest that exist" — so the sentence must
    // disappear even though the repair itself succeeded identically.
    const upper = render({
      engine: "z3",
      solver_ran: true,
      status: "repaired",
      moved: 2,
      minimality: "upper_bound",
    });
    expect(upper).toContain('data-minimality="upper_bound"');
    expect(upper).not.toContain(enDict["board.ai.repaired.minimal"]!);
  });

  it("names what was left for the model", () => {
    const html = render({
      engine: "z3",
      solver_ran: true,
      status: "partial",
      moved: 3,
      unresolved: 4,
    });
    expect(html).toContain('data-unresolved="4"');
    expect(html).toContain('data-moved="3"');
  });

  it("localizes into fr rather than printing English", () => {
    const html = render(
      { engine: "z3", solver_ran: true, status: "repaired", moved: 2, minimality: "proved" },
      frDict,
      "fr",
    );
    expect(html).toContain(frDict["board.ai.repaired.freeOfCharge"]!);
    expect(html).not.toContain(enDict["board.ai.repaired.freeOfCharge"]!);
    // Guards the assertion above: if the two locales ever carried the same
    // string, "not English" would pass without proving anything.
    expect(frDict["board.ai.repaired.freeOfCharge"]).not.toBe(
      enDict["board.ai.repaired.freeOfCharge"],
    );
  });
});
