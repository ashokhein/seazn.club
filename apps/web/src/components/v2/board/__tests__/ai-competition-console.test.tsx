// The JOINT console (#350 Task 8) — the surface that makes multi-division AI
// scheduling reachable at all.
//
// It is rendered from the TOP wherever it can be: `renderToStaticMarkup` of the
// whole `AiCompetitionConsole` runs the state initialisers, so the default
// selection, the quote lines, the CTA's price and both warnings are the
// component's own derivations from board data — not values a test handed it.
// Handing a component the answer it is supposed to compute has defeated three
// fixes on this branch already.
//
// The review step is a separate exported function component for the same reason
// in reverse: its inputs (a plan, the divisions, what was set aside) are raw,
// and everything interesting about it — which warnings will block the apply,
// what a refusal means — is derived, so calling it directly still pins the
// derivation.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Dict } from "@/lib/i18n-constants";
import { DictProvider } from "@/components/i18n/dict-provider";
import en from "@/dictionaries/en/ui.json";
import { quoteRun, schedulingRungWeights } from "@/lib/ai-rung";
import type { AiCompetitionPlanResponse } from "@/server/api-v1/schemas";
import {
  AiCompetitionConsole,
  JointReviewStep,
  canRunJoint,
  divergentCourts,
  jointApplyDivisions,
  jointQuoteLines,
  personClashRisk,
  pickerDivisions,
  rungOverrides,
  timezoneSpread,
  type JointDivision,
} from "../ai-competition-console";

const dict = en as unknown as Dict;
const enText = en as unknown as Record<string, string>;

function tEn(key: string, vars?: Record<string, string | number>): string {
  const raw = enText[key] ?? key;
  return vars ? raw.replace(/\{(\w+)\}/g, (m, n) => (n in vars ? String(vars[n]) : m)) : raw;
}

/**
 * Four divisions that differ on EVERY dimension a test here cares about, so no
 * assertion can be satisfied by the wrong one:
 *   - d1 and d2 predict DIFFERENT rungs (1 and 2), so the receipt cannot pass by
 *     showing one line's number for both;
 *   - their court lists overlap but are not equal;
 *   - their timezones differ;
 *   - d3 has nothing to place and d4 is frozen — two different reasons a
 *     division cannot join a run, which must not be shown as the same thing.
 */
const DIVISIONS: JointDivision[] = [
  {
    id: "d1",
    name: "Under 12s",
    seq: 4,
    scheduleLocked: false,
    courts: ["Court 1", "Court 2"],
    tz: "Europe/London",
    personClashBlocks: false,
    movableFixtures: 8,
    activeEntrants: 6,
  },
  {
    id: "d2",
    name: "Under 14s",
    seq: 11,
    scheduleLocked: false,
    courts: ["Court 1", "Court 3"],
    tz: "America/New_York",
    personClashBlocks: true,
    movableFixtures: 120,
    activeEntrants: 40,
  },
  {
    id: "d3",
    name: "Under 16s",
    seq: 2,
    scheduleLocked: false,
    courts: ["Court 1"],
    tz: "Europe/London",
    personClashBlocks: false,
    movableFixtures: 0,
    activeEntrants: 12,
  },
  {
    id: "d4",
    name: "Masters",
    seq: 9,
    scheduleLocked: true,
    courts: ["Court 1"],
    tz: "Europe/London",
    personClashBlocks: false,
    movableFixtures: 30,
    activeEntrants: 10,
  },
];

function render(divisions = DIVISIONS): string {
  return renderToStaticMarkup(
    <DictProvider dict={dict} locale="en">
      <AiCompetitionConsole
        competitionId="c1"
        divisions={divisions}
        aiAllowed
        currency="usd"
        fixtures={[]}
        onClose={() => {}}
      />
    </DictProvider>,
  );
}

/** The checkbox rows the picker rendered, in order. */
function pickerRows(html: string) {
  return [...html.matchAll(/<input[^>]*data-division-id="(\w+)"[^>]*>/g)].map((m) => ({
    id: m[1],
    disabled: /disabled/.test(m[0]),
    checked: /checked/.test(m[0]),
  }));
}

const attr = (html: string, name: string): string | null =>
  new RegExp(`${name}="([^"]*)"`).exec(html)?.[1] ?? null;

describe("the divisions a joint run starts with", () => {
  it("selects every division with something to place, and neither of the two that cannot join", () => {
    // d3 has nothing to place; d4 is frozen — the plan endpoint answers 409
    // SCHEDULE_LOCKED for a single frozen division and refuses the WHOLE run,
    // so offering it would let an organiser lose the run to a division they did
    // not even mean to change.
    expect(pickerRows(render())).toEqual([
      { id: "d1", disabled: false, checked: true },
      { id: "d2", disabled: false, checked: true },
      { id: "d3", disabled: true, checked: false },
      { id: "d4", disabled: true, checked: false },
    ]);
  });

  it("says WHY each unavailable division is unavailable, in its own words", () => {
    // One shared "can't use this" label would tell an organiser to go and add
    // fixtures to a division that just needs unfreezing.
    const html = render();
    expect(html).toContain(enText["board.ai.picker.nothingToPlace"]);
    expect(html).toContain(enText["board.ai.picker.frozen"]);
  });

  it("says so on the board when only one division is left to select", () => {
    // Mirrors the server's 400 AI_PLAN_SINGLE_DIVISION as a SHAPE rather than a
    // failure. Driven by the data — the selection is the component's own — so
    // this proves the console derives the selection, not that a prop was passed.
    // The CTA is disabled here too, but it is disabled on an EMPTY BRIEF as
    // well, so the hint is the only thing that discriminates in the markup.
    const html = render([DIVISIONS[0], DIVISIONS[2], DIVISIONS[3]]);
    expect(html).toContain(enText["board.ai.picker.needTwo"]);
    expect(/<button[^>]*data-ai-joint-run[^>]*disabled/.test(html)).toBe(true);
    expect(render()).not.toContain(enText["board.ai.picker.needTwo"]);
  });

  it("gates the run on the selection independently of the brief", () => {
    // The half the render cannot show: with a perfectly good brief, one division
    // still cannot start a joint run.
    const brief = "Finish every division by 6pm.";
    expect(canRunJoint({ selected: ["d1"], instruction: brief, running: false })).toBe(false);
    expect(canRunJoint({ selected: ["d1", "d1"], instruction: brief, running: false })).toBe(false);
    expect(canRunJoint({ selected: ["d1", "d2"], instruction: brief, running: false })).toBe(true);
    // …and the other two reasons, each on its own.
    expect(canRunJoint({ selected: ["d1", "d2"], instruction: "  ", running: false })).toBe(false);
    expect(canRunJoint({ selected: ["d1", "d2"], instruction: brief, running: true })).toBe(false);
  });
});

describe("the price the organiser is shown", () => {
  it("prices one line per selected division, each labelled with its name", () => {
    // EVERY line must carry a label. `oversizedNames` filters on Boolean(label),
    // so an unlabelled joint line falls back to the singular "split the
    // division" copy — advice that names no division on a run covering several.
    const lines = jointQuoteLines(DIVISIONS, ["d1", "d2"], {});
    expect(lines.map((l) => ({ key: l.key, label: l.label }))).toEqual([
      { key: "d1", label: "Under 12s" },
      { key: "d2", label: "Under 14s" },
    ]);
    expect(lines.map((l) => l.input)).toEqual([
      { movableFixtures: 8, entrants: 6, courts: 2 },
      { movableFixtures: 120, entrants: 40, courts: 2 },
    ]);
  });

  it("the CTA and the receipt name the same number, and it is the number quoteRun gives", () => {
    // Two call sites pricing one run is how a button and the card above it come
    // to disagree. The independent `quoteRun` here is what stops both of them
    // being wrong together: d1 predicts rung 1 and d2 rung 2, so the batch
    // discount takes 3 to 2 — a total that no single line could produce.
    const expected = quoteRun(
      [
        { key: "d1", input: { movableFixtures: 8, entrants: 6, courts: 2 } },
        { key: "d2", input: { movableFixtures: 120, entrants: 40, courts: 2 } },
      ],
      schedulingRungWeights(),
    );
    expect(expected.credits).toBe(2);
    expect(expected.discount).toBe(1);

    const html = render();
    expect(attr(html, "data-ai-credits")).toBe("2");
    expect(attr(html, "data-ai-joint-cta-credits")).toBe("2");
  });

  it("names the division that is too large, not 'this division'", () => {
    // The joint layout's warning is per line precisely so the advice is
    // actionable. Falling back to the singular copy on a joint run is the bug
    // the per-line attribution replaced.
    const huge: JointDivision = {
      ...DIVISIONS[1],
      id: "d5",
      name: "Open singles",
      movableFixtures: 520,
      activeEntrants: 60,
      courts: ["Court 1", "Court 2", "Court 3", "Court 4"],
    };
    const html = render([DIVISIONS[0], huge]);
    expect(html).toContain(
      tEn("board.ai.quote.veryLargeDivisions.one", { divisions: "Open singles" }),
    );
    expect(html).not.toContain(enText["board.ai.quote.veryLarge"]);
    expect(html).not.toContain(enText["board.ai.quote.thisDivision"]);
  });
});

describe("what the board cannot know about the divisions it is merging", () => {
  it("names the court labels that are not shared by every selected division", () => {
    // Cross-division court identity is a string match and nothing else. "Court
    // 2" existing only in one division means it is NOT the other's "Court 2" —
    // and neither is anything else.
    expect(divergentCourts(DIVISIONS, ["d1", "d2"])).toEqual(["Court 2", "Court 3"]);
    const html = render();
    expect(html).toContain(tEn("board.ai.joint.courtsDivergent", { courts: "Court 2, Court 3" }));
  });

  it("says nothing about courts when the selected divisions share them all", () => {
    // The contrast is the test: a banner that always renders satisfies the
    // assertion above without detecting anything.
    const same = DIVISIONS.map((d) => ({ ...d, courts: ["Court 1", "Court 2"] }));
    expect(divergentCourts(same, ["d1", "d2"])).toEqual([]);
    expect(render(same)).not.toContain(enText["board.ai.joint.courtsDivergentTitle"]);
  });

  it("says which timezone the times are being read in when the divisions disagree", () => {
    // Ruling R8: every internal comparison is epoch ms, but the board renders in
    // the reader's own zone while each division is configured in its own. On a
    // mixed-zone competition an unlabelled clock is a trap.
    expect(timezoneSpread(DIVISIONS, ["d1", "d2"])).toEqual([
      { tz: "America/New_York", divisions: ["Under 14s"] },
      { tz: "Europe/London", divisions: ["Under 12s"] },
    ]);
    expect(timezoneSpread(DIVISIONS, ["d1", "d3"])).toEqual([]);
    const html = render();
    expect(html).toContain(enText["board.ai.joint.tzMixedTitle"]);
    expect(render(DIVISIONS.map((d) => ({ ...d, tz: "Europe/London" })))).not.toContain(
      enText["board.ai.joint.tzMixedTitle"],
    );
  });
});

describe("rungOverrides — where a confirmed price becomes a sent price", () => {
  it("sends only the rungs the organiser picked, for divisions actually in the run", () => {
    // A per-division `chosen: null` means "server, size this one yourself", and
    // must send NO entry — sending the client's guess freezes a stale estimate
    // into the charge. An entry for a division that was deselected after being
    // adjusted would price a division the run does not cover.
    expect(
      rungOverrides({ d1: 3, d2: null, d3: 2 }, ["d1", "d2"]),
    ).toEqual({ rung_overrides: { d1: 3 } });
  });

  it("omits the field entirely when every line follows the prediction", () => {
    // `{}` and an absent key are not the same over the wire.
    expect("rung_overrides" in rungOverrides({ d1: null, d2: null }, ["d1", "d2"])).toBe(false);
    expect("rung_overrides" in rungOverrides({}, ["d1", "d2"])).toBe(false);
  });

  it("drops a value that is not a rung rather than forwarding it", () => {
    for (const junk of [0, 4, -1, 1.5, Number.NaN]) {
      expect("rung_overrides" in rungOverrides({ d1: junk }, ["d1"]), String(junk)).toBe(false);
    }
  });
});

describe("pickerDivisions", () => {
  it("carries each division's own count and its own reason for being unusable", () => {
    expect(pickerDivisions(DIVISIONS)).toEqual([
      { id: "d1", name: "Under 12s", movable: 8, locked: false },
      { id: "d2", name: "Under 14s", movable: 120, locked: false },
      { id: "d3", name: "Under 16s", movable: 0, locked: false },
      { id: "d4", name: "Masters", movable: 30, locked: true },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Review step
// ---------------------------------------------------------------------------

const plan = (over: Partial<AiCompetitionPlanResponse> = {}): AiCompetitionPlanResponse =>
  ({
    proposal: [
      { fixture_id: "f1", scheduled_at: "2026-08-01T09:00:00.000Z", court_label: "Court 1", division_id: "d1" },
      { fixture_id: "f2", scheduled_at: "2026-08-01T10:00:00.000Z", court_label: "Court 1", division_id: "d2" },
    ],
    unschedulable: [],
    warnings: [],
    blocking: [],
    diff: { moved: [], placed: ["f1", "f2"], unscheduled: [], unchanged: [] },
    explanations: [],
    summary: "Two divisions placed on shared courts.",
    divergent_courts: [],
    skipped_divisions: [],
    usage: { input_tokens: 10, output_tokens: 20, repair_rounds: 0 },
    credits: 2,
    divisions: [
      { id: "d1", name: "Under 12s", movable: 8, rung: 1, predicted_rung: 1, underfunded: false },
      { id: "d2", name: "Under 14s", movable: 120, rung: 2, predicted_rung: 2, underfunded: false },
    ],
    ...over,
  }) as AiCompetitionPlanResponse;

function review(
  over: Partial<Parameters<typeof JointReviewStep>[0]> = {},
): string {
  return renderToStaticMarkup(
    <DictProvider dict={dict} locale="en">
      <JointReviewStep
        plan={plan()}
        divisions={DIVISIONS}
        selected={["d1", "d2"]}
        excluded={[]}
        fixtures={[]}
        applying={false}
        outcome={null}
        undoing={false}
        undone="no"
        onToggleExclude={() => {}}
        onApply={() => {}}
        onDiscard={() => {}}
        onUndo={() => {}}
        onBack={() => {}}
        onReRun={() => {}}
        msg={(k, v) => tEn(k as string, v)}
        {...over}
      />
    </DictProvider>,
  );
}

describe("jointApplyDivisions — the payload the apply is built from", () => {
  it("gives each division its OWN seq token and only its own placements", () => {
    // d1's seq is 4 and d2's is 11. One token reused for both is a stale-board
    // check that guards one division and waves the other through — and the
    // seqs differ here precisely so that cannot pass by coincidence.
    expect(jointApplyDivisions(plan(), DIVISIONS)).toEqual([
      {
        divisionId: "d1",
        expectedSeq: 4,
        assignments: [
          { fixture_id: "f1", scheduled_at: "2026-08-01T09:00:00.000Z", court_label: "Court 1" },
        ],
      },
      {
        divisionId: "d2",
        expectedSeq: 11,
        assignments: [
          { fixture_id: "f2", scheduled_at: "2026-08-01T10:00:00.000Z", court_label: "Court 1" },
        ],
      },
    ]);
  });

  it("drops a placement for a division the board does not know", () => {
    // Rather than sending it under a guessed seq. The board is the only source
    // of the token, so a division it has never heard of has no honest one.
    const stray = plan({
      proposal: [
        ...plan().proposal,
        { fixture_id: "f9", scheduled_at: "2026-08-01T11:00:00.000Z", court_label: "Court 1", division_id: "gone" },
      ],
    });
    expect(jointApplyDivisions(stray, DIVISIONS).map((d) => d.divisionId)).toEqual(["d1", "d2"]);
  });
});

describe("a person clash the plan only warns about but the apply refuses", () => {
  const clash = plan({
    warnings: [
      { fixtureId: "f1", reason: "person_overlap", detail: "Sam Reyes" },
      { fixtureId: "f2", reason: "rest", detail: "20 minutes" },
    ],
  });

  it("counts only the person clashes, and only when a selected division blocks them", () => {
    // The rest warning is the decoy: a count that reads `warnings.length` says 2
    // and is wrong about what Apply will refuse.
    expect(personClashRisk(clash.warnings, DIVISIONS, ["d1", "d2"])).toEqual({
      count: 1,
      divisions: ["Under 14s"],
    });
    // Only d1 selected — nothing in the run blocks a person clash, so the
    // warning stays a warning and Apply will not refuse it.
    expect(personClashRisk(clash.warnings, DIVISIONS, ["d1"])).toEqual({
      count: 0,
      divisions: [],
    });
  });

  it("warns before Apply, naming the division whose rule refuses it", () => {
    const html = review({ plan: clash });
    expect(html).toContain(
      tEn("board.ai.joint.personClash.one", { count: 1, divisions: "Under 14s" }),
    );
    // Contrast: the same warnings with no blocking division must NOT raise it.
    const soft = review({ plan: clash, divisions: DIVISIONS.map((d) => ({ ...d, personClashBlocks: false })) });
    expect(soft).not.toContain(tEn("board.ai.joint.personClash.one", { count: 1, divisions: "Under 14s" }));
  });
});

describe("what a refused apply tells the organiser", () => {
  const conflict = {
    status: "conflict" as const,
    checkpoints: [],
    applied: 0,
    conflicts: [{ fixtureId: "f2", reason: "court", detail: "Court 1 at 10:00" }],
  };

  it("explains that fixtures set aside kept their old times and are still holding courts", () => {
    // A partial apply leaves the excluded fixtures where they were, so they are
    // obstacles that did not exist at plan time. The refusal is correct; without
    // this line it reads as the plan having been wrong.
    const html = review({ outcome: conflict, excluded: ["f1"] });
    expect(html).toContain(enText["board.ai.joint.conflictAside"]);
  });

  it("does not blame a set-aside fixture when nothing was set aside", () => {
    const html = review({ outcome: conflict, excluded: [] });
    expect(html).not.toContain(enText["board.ai.joint.conflictAside"]);
    expect(html).toContain(tEn("board.ai.joint.conflict.one", { count: 1 }));
  });

  it("offers a re-run only for a stale board, never for a real clash", () => {
    const stale = review({ outcome: { ...conflict, status: "seq_conflict", conflicts: [] } });
    expect(stale).toContain(enText["board.ai.apply.reRunRefine"]);
    expect(review({ outcome: conflict })).not.toContain(enText["board.ai.apply.reRunRefine"]);
  });
});

describe("the applied state", () => {
  const applied = {
    status: "applied" as const,
    checkpoints: [
      { divisionId: "d1", checkpointId: "cp-1" },
      { divisionId: "d2", checkpointId: "cp-2" },
    ],
    applied: 2,
    conflicts: [],
  };

  it("offers Undo, because the apply took a restore point for every division", () => {
    const html = review({ outcome: applied });
    expect(html).toContain(enText["board.ai.joint.savepoint"]);
    expect(html).toContain(enText["board.ai.apply.undo"]);
  });

  it("says so when only some divisions could be reverted", () => {
    // Restore is per division and cannot be rolled back part-way, so "reverted"
    // would be a lie for the divisions that refused.
    expect(review({ outcome: applied, undone: "partial" })).toContain(
      enText["board.ai.joint.undonePartial"],
    );
    expect(review({ outcome: applied, undone: "full" })).toContain(
      enText["board.ai.apply.reverted"],
    );
  });
});
