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
import type { AiCompetitionPlanResponse, AiParsePreviewResponse } from "@/server/api-v1/schemas";
import type { AiConsoleFixture } from "../ai-diff";
import {
  AiCompetitionConsole,
  IDLE_JOINT_PREVIEW,
  JointReviewStep,
  canRunJoint,
  type JointPreview,
  divergentCourts,
  jointApplyDivisions,
  jointQuoteLines,
  personClashRisk,
  pickerDivisions,
  timezoneSpread,
  usableSelection,
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

/**
 * Is that button really disabled?
 *
 * Anchored on `disabled=""` — the attribute React actually emits for a `true`
 * boolean — and NOT on the bare word, because every one of these buttons
 * carries `disabled:cursor-not-allowed` in its className. A `[^>]*disabled`
 * probe matches the class and is satisfied whatever the prop says.
 */
const disabledButton = (html: string, marker: string): boolean =>
  new RegExp(`<button[^>]*${marker}[^>]*disabled=""`).test(html);

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
    expect(disabledButton(html, "data-ai-joint-run")).toBe(true);
    expect(render()).not.toContain(enText["board.ai.picker.needTwo"]);
  });

  it("gates the run on the selection independently of the brief", () => {
    // The half the render cannot show: with a perfectly good brief AND a
    // confirmed compile, one division still cannot start a joint run.
    const ok = { instruction: BRIEF, running: false, preview: confirmedPreview() };
    expect(canRunJoint({ ...ok, selected: ["d1"] })).toBe(false);
    expect(canRunJoint({ ...ok, selected: ["d1", "d1"] })).toBe(false);
    expect(canRunJoint({ ...ok, selected: ["d1", "d2"] })).toBe(true);
    // …and the other two reasons, each on its own.
    expect(canRunJoint({ ...ok, selected: ["d1", "d2"], instruction: "  " })).toBe(false);
    expect(canRunJoint({ ...ok, selected: ["d1", "d2"], running: true })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The confirm gate (W5 #400, Task 7)
// ---------------------------------------------------------------------------

const BRIEF = "Finish every division by 6pm.";

const COMPILED = {
  preview_id: "0f3a1c26-9f21-4c2e-8f0e-2b7c1f2d4a55",
  failed: false,
  compiled: {
    hard: [{ type: "max_fixtures_per_day", count: 2, scope: { kind: "competition" } }],
    soft: [],
    unparsed: [],
    assumptions: ["Read 'by 6pm' as the venue's own clock."],
  },
  window: null,
  expires_at: "2026-08-03T12:00:00.000Z",
} as unknown as AiParsePreviewResponse;

/** A compile the organiser has been shown, for THIS sentence and THESE
 *  divisions — the only state from which a joint run may start. */
function confirmedPreview(over: Partial<JointPreview["slice"]> = {}): JointPreview {
  return {
    slice: {
      status: "ready",
      data: COMPILED,
      id: COMPILED.preview_id ?? null,
      asPreference: false,
      instruction: BRIEF,
      ...over,
    },
    divisionIds: ["d1", "d2"],
  };
}

describe("the joint run will not start before the compile is confirmed", () => {
  // THE gate. The joint console spends exactly as the division console does, so
  // it must refuse to spend for the same reason: nobody has yet seen what the
  // sentence compiled to.
  it("refuses a run on a good brief with no compile in hand", () => {
    expect(
      canRunJoint({
        selected: ["d1", "d2"],
        instruction: BRIEF,
        running: false,
        preview: IDLE_JOINT_PREVIEW,
      }),
    ).toBe(false);
    // The positive discriminator: the SAME brief and selection, once compiled.
    expect(
      canRunJoint({
        selected: ["d1", "d2"],
        instruction: BRIEF,
        running: false,
        preview: confirmedPreview(),
      }),
    ).toBe(true);
  });

  it("reads the division console's own gate rather than a second copy of it", () => {
    // One definition, so the two consoles cannot come to different conclusions
    // about whether the organiser has agreed to anything. Every case below is
    // `canRun`'s, exercised through the joint wrapper.
    const state = (preview: JointPreview) => ({
      selected: ["d1", "d2"],
      instruction: BRIEF,
      running: false,
      preview,
    });
    // A compile that failed schema twice carries no reusable id — and taking
    // the preference fallback is the organiser's explicit choice, not ours.
    const failed = confirmedPreview({ id: null, data: { ...COMPILED, failed: true } });
    expect(canRunJoint(state(failed))).toBe(false);
    expect(canRunJoint(state({ ...failed, slice: { ...failed.slice, asPreference: true } }))).toBe(
      true,
    );
    // Still compiling.
    expect(canRunJoint(state(confirmedPreview({ status: "loading" })))).toBe(false);
    // Rules confirmed for one sentence can never run another.
    expect(canRunJoint(state(confirmedPreview({ instruction: "Something else entirely." })))).toBe(
      false,
    );
  });

  it("refuses a compile taken against a different set of divisions", () => {
    // Task 2b made this a 409 PREVIEW_STALE on the server, because the resolved
    // WINDOW depends on which divisions are in scope: a preview minted for two
    // divisions describes a different run from the one three would make. The
    // client must not offer a confirm it knows the server will refuse.
    const narrower = { ...confirmedPreview(), divisionIds: ["d1"] };
    expect(
      canRunJoint({ selected: ["d1", "d2"], instruction: BRIEF, running: false, preview: narrower }),
    ).toBe(false);
    // Order is not identity — the same two divisions in either order is the
    // same run, and re-checking the picker after a reorder is noise.
    const reordered = { ...confirmedPreview(), divisionIds: ["d2", "d1"] };
    expect(
      canRunJoint({ selected: ["d1", "d2"], instruction: BRIEF, running: false, preview: reordered }),
    ).toBe(true);
  });

  it("shows the compile button first, and the run only after the confirm", () => {
    // The markup half: a fresh console offers "Check what this means", not a
    // button that spends. Anchored on `="` — React serialises an omitted prop
    // as `"$undefined"`, so a bare `data-ai-joint-stage` probe passes in both
    // states.
    const html = render();
    expect(html).toContain('data-ai-joint-stage="check"');
    expect(html).not.toContain('data-ai-joint-stage="run"');
    expect(html).toContain(enText["board.ai.preview.check"]);
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

/** One fixture as the competition board hands it to the console — including the
 *  division that owns it, which is the ONLY source for the chip on a row the
 *  proposal never touched. */
function jointFixture(id: string, divisionId: string, matchup: string): AiConsoleFixture {
  return {
    id,
    division_id: divisionId,
    stage_id: "st-1",
    scheduled_at: null,
    court_label: null,
    code: "R1·1",
    matchup,
    isFinal: false,
    isJunior: false,
    status: "scheduled",
    home_entrant_id: "en-a",
    away_entrant_id: "en-b",
  };
}

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
        running={false}
        error={null}
        currency="usd"
        undoFailed={[]}
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
  // f1 is owned by d1 (crossPersonClash: "warn"), f2 by d2 ("hard"). The SERVER
  // blocks a person overlap only when the division that OWNS the fixture is
  // hard — "NOT a union over the request", in its own words
  // (competition-schedule-apply.ts:511-521). So exactly one of these two
  // overlaps will be refused, and a count that unions over the selection says
  // two and tells the organiser a good plan will be rejected.
  const clash = plan({
    warnings: [
      { fixtureId: "f2", reason: "person_overlap", detail: "Sam Reyes" },
      { fixtureId: "f1", reason: "person_overlap", detail: "Ali Khan" },
      { fixtureId: "f2", reason: "rest", detail: "20 minutes" },
    ],
  });

  it("counts only the clashes owned by a division whose own rule refuses them", () => {
    // The rest warning is one decoy — `warnings.length` says 3. The overlap in
    // the WARN division is the other: unioning over the selection says 2. Only
    // the owner-keyed count says 1.
    expect(personClashRisk(clash, DIVISIONS, ["d1", "d2"])).toEqual({
      count: 1,
      divisions: ["Under 14s"],
    });
  });

  it("threatens nothing when every clash is owned by a division content to warn", () => {
    // d2 is still selected and still `hard` — but it owns no overlap here, so
    // Apply will accept all of them.
    const softOwners = plan({
      warnings: [{ fixtureId: "f1", reason: "person_overlap", detail: "Ali Khan" }],
    });
    expect(personClashRisk(softOwners, DIVISIONS, ["d1", "d2"])).toEqual({
      count: 0,
      divisions: [],
    });
    // …and neither does a board where no selected division blocks at all.
    expect(
      personClashRisk(clash, DIVISIONS.map((d) => ({ ...d, personClashBlocks: false })), ["d1", "d2"]),
    ).toEqual({ count: 0, divisions: [] });
  });

  it("ignores a clash owned by a division that is not in the run", () => {
    // The third filter, and the one the fixture above cannot exercise: it
    // selects both divisions, so `chosen` is inert in every assertion there.
    // `usableSelection` narrows the picks DURING render, so a refresh that
    // freezes d2 under an open console drops it from the run while the plan on
    // screen still carries its fixtures — and d2's rule cannot refuse a write
    // the apply will never be asked to make.
    expect(personClashRisk(clash, DIVISIONS, ["d1"])).toEqual({ count: 0, divisions: [] });
    // The positive discriminator, so this cannot pass by the count being 0 for
    // some other reason: put d2 back and the same plan threatens one refusal.
    expect(personClashRisk(clash, DIVISIONS, ["d1", "d2"]).count).toBe(1);
  });

  it("warns before Apply, naming the division whose rule refuses it", () => {
    const html = review({ plan: clash });
    expect(html).toContain(
      tEn("board.ai.joint.personClash.one", { count: 1, divisions: "Under 14s" }),
    );
    const soft = review({
      plan: clash,
      divisions: DIVISIONS.map((d) => ({ ...d, personClashBlocks: false })),
    });
    expect(soft).not.toContain(tEn("board.ai.joint.personClash.one", { count: 1, divisions: "Under 14s" }));
  });

  it("lists every engine warning, so the count matches what is on screen", () => {
    // A "3 warnings to review" line above two amber rows that are NOT warnings
    // (the skipped division, the court-name mismatch) and one that is reads as
    // a bug even when it is not. The fix is to show what is counted.
    const html = review({ plan: clash });
    expect(html).toContain('data-review-count="3"');
    // One row per warning, in the order the engine raised them.
    expect([...html.matchAll(/data-review-row="([^"]*)"/g)].map((m) => m[1])).toEqual([
      "warning",
      "warning",
      "warning",
    ]);
    // …and no card at all when the engine raised none.
    expect(review({ plan: plan({ warnings: [] }) })).not.toContain('data-review-count="');
  });
});

// ---------------------------------------------------------------------------
// The one count (#388)
// ---------------------------------------------------------------------------

describe("what the joint review says there is to review", () => {
  const u1 = { fixture_id: "f7", reason: "no court free in the window", rule: "CAP" as const };

  /**
   * Just the review card. The division LEDGER above it wears a chip per
   * selected division, so an unscoped `data-division-chip` probe is answered by
   * the ledger and says nothing about the rows.
   *
   * Anchored on `data-review-count`, NOT on the first `<section>`. The card
   * being the step's only section was true by accident and stopped being true
   * the moment this console grew a preview card (W5 #400) — a `<section>` above
   * the panel silently retargets every assertion below without failing one.
   */
  function card(html: string): string {
    const anchor = html.indexOf('data-review-count="');
    expect(anchor).toBeGreaterThan(-1);
    const from = html.lastIndexOf("<section", anchor);
    expect(from).toBeGreaterThan(-1);
    return html.slice(from, html.indexOf("</section>", from));
  }

  // #388 in one assertion. The old header read `plan.warnings.length` and said
  // "1 warning to review" while three amber rows sat underneath it — the
  // warning, the fixture nobody could place, and the architect's assumption.
  it("counts assumptions and unschedulable fixtures, not just warnings", () => {
    const html = review({
      plan: plan({
        warnings: [{ fixtureId: "f1", reason: "rest", detail: "20 minutes" }],
        unschedulable: [u1],
        assumptions: ["Read 'the weekend' as Sat + Sun."],
      } as Partial<AiCompetitionPlanResponse>),
    });
    expect(html).toContain('data-review-count="3"');
    // The count IS the rows on screen — the property #388 exists to protect.
    // `plan.warnings.length` is 1 here, so the old header would read "1" while
    // three rows sat under it; this fails for any number keyed on one kind.
    const kinds = [...html.matchAll(/data-review-row="([^"]*)"/g)].map((m) => m[1]);
    expect(html).toContain(`data-review-count="${kinds.length}"`);
    // Exactly one number on the card, and it is that one. This is the guard
    // that would fail if a second count were reintroduced anywhere on the step.
    expect(html.match(/data-review-count="/g) ?? []).toHaveLength(1);
    expect(kinds).toEqual(["warning", "unschedulable", "assumption"]);
  });

  // Carried from the Task 5 review. `skipped_divisions` and `divergent_courts`
  // are division-level facts about the run's SCOPE, not per-fixture findings —
  // Task 4's three review categories do not include them. Sitting in the same
  // amber band as the counted card, they read as rows the count had missed.
  // The ruling was to demote them, not to count them: folding them in would
  // make one number mean two different units.
  it("keeps the division-level notes out of the counted amber band", () => {
    const html = review({
      plan: plan({
        warnings: [{ fixtureId: "f1", reason: "rest", detail: "20 minutes" }],
        skipped_divisions: [{ id: "d3", name: "Under 16s", reason: "no_movable_fixtures" }],
        divergent_courts: ["Court 3"],
      } as Partial<AiCompetitionPlanResponse>),
    });
    // Still said, and still where the ledger they are about is.
    expect(html).toContain(tEn("board.ai.joint.skipped", { divisions: "Under 16s" }));
    expect(html).toContain(tEn("board.ai.joint.courtsDivergent", { courts: "Court 3" }));
    expect(html.match(/data-scope-note="1"/g) ?? []).toHaveLength(2);
    // Not amber, so the eye does not group them with the counted rows…
    const notes = [...html.matchAll(/<div data-scope-note="1" class="([^"]*)"/g)].map((m) => m[1]);
    expect(notes).toHaveLength(2);
    expect(notes.every((c) => !c.includes("amber"))).toBe(true);
    // …and not counted, because a court-name mismatch is not a fixture.
    expect(html).toContain('data-review-count="1"');
    expect(html.match(/data-review-count="/g) ?? []).toHaveLength(1);
  });

  // Must-fix 1. `plan.proposal` and `plan.unschedulable` are mutually exclusive
  // — the server dedupes one against the other — so a division map built from
  // the proposal returns null for every unschedulable row. On the joint console
  // the chip is the ONLY thing naming a row's division, so those rows would
  // lose the one piece of context they most need. f7 is deliberately absent
  // from the proposal and present on the board.
  it("names the division of a fixture the plan could not place", () => {
    const row = card(
      review({
        plan: plan({ unschedulable: [u1] } as Partial<AiCompetitionPlanResponse>),
        fixtures: [jointFixture("f7", "d2", "Osei vs Pereira")],
      }),
    );
    expect(row).toContain('data-division-chip="');
    expect(row).toContain("Under 14s");
    expect(row).toContain("Osei vs Pereira");
  });

  // Never guessed. A fixture the board does not hold has no honest division, so
  // the row renders without a chip rather than borrowing a neighbour's.
  it("omits the chip when the board does not know the fixture's division", () => {
    const row = card(
      review({
        plan: plan({ unschedulable: [u1] } as Partial<AiCompetitionPlanResponse>),
        fixtures: [],
      }),
    );
    expect(row).toContain('data-review-count="1"');
    expect(row).not.toContain('data-division-chip="');
  });
});

describe("a run started from the review step", () => {
  // The re-run button exists ONLY inside the stale-board branch, and a failed
  // run leaves `outcome` exactly where it was — `run()` clears it on success and
  // nowhere else. So the step returns at that branch and a re-run failure can
  // surface at one mount and one only: the one below this panel.
  //
  // Rendering these with the default `outcome: null` pinned the main review
  // body's mount instead, which a failed re-run cannot reach. Deleting the
  // reachable mount left the whole suite green. Both are asserted here now, so
  // the repoint does not trade one blind spot for another.
  const stale = { status: "seq_conflict" as const, checkpoints: [], applied: 0, conflicts: [] };

  it("shows the re-run as in flight, so a second click is not the obvious move", () => {
    // The button is the AFFORDANCE (the guard is in runJointPlan); without it
    // the review step shows no change at all during a run that takes tens of
    // seconds, and a second click spends again.
    const idle = review({ outcome: stale });
    expect(disabledButton(idle, "data-ai-joint-rerun")).toBe(false);
    const busy = review({ outcome: stale, running: true });
    expect(disabledButton(busy, "data-ai-joint-rerun")).toBe(true);
    expect(busy).toContain(enText["board.ai.joint.running"]);
  });

  it("shows a failed re-run instead of leaving the old proposal looking successful", () => {
    // `run()` leaves `plan` in place on failure, and the review step renders
    // whenever a plan exists — so without this a 402/403/500 changed NOTHING on
    // screen and the organiser had no idea the remedy had failed.
    const err = { message: "Too many runs just now.", key: "board.ai.error.rateLimited" };
    // The branch the failure actually lands on.
    expect(review({ outcome: stale, error: err })).toContain("Too many runs just now.");
    // Contrast on that same branch: the stale-board panel with nothing wrong
    // says nothing.
    expect(review({ outcome: stale })).not.toContain(enText["board.ai.errorLabel"]);
    // …and the main review body still renders it, for the run that fails before
    // any apply has been attempted.
    expect(review({ error: err })).toContain("Too many runs just now.");
    expect(review({})).not.toContain(enText["board.ai.errorLabel"]);
  });

  it("routes an empty wallet to the top-up block, not to a red line", () => {
    const err = { message: "out", key: "board.ai.error.outOfCredits" };
    expect(review({ outcome: stale, error: err })).toContain(
      enText["board.ai.error.outOfCreditsTitle"],
    );
    expect(review({ error: err })).toContain(enText["board.ai.error.outOfCreditsTitle"]);
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

  it("does not claim a full revert when only some divisions were reverted", () => {
    // The headline is what a scanning reader takes away. "Reverted to before
    // the AI changes." above an amber line saying otherwise actively
    // misinforms — the remaining divisions are still carrying the AI board.
    const partial = review({ outcome: applied, undone: "partial", undoFailed: ["d2"] });
    expect(partial).not.toContain(enText["board.ai.apply.reverted"]);
    expect(review({ outcome: applied, undone: "full" })).toContain(
      enText["board.ai.apply.reverted"],
    );
  });

  it("names the divisions that are still on the AI board, and offers to try them again", () => {
    // Without the names the organiser has to open every division page to find
    // out which. The anchors are still valid and a restore failure is often
    // transient, so the retry is the remedy — the copy pointing at the division
    // pages is the fallback, not the first answer.
    const partial = review({ outcome: applied, undone: "partial", undoFailed: ["d2"] });
    expect(partial).toContain(
      tEn("board.ai.joint.undonePartial", { divisions: "Under 14s" }),
    );
    expect(partial).toContain(enText["board.ai.joint.undoRetry"]);
    // A full revert has nothing to retry.
    expect(review({ outcome: applied, undone: "full" })).not.toContain(
      enText["board.ai.joint.undoRetry"],
    );
  });
});

describe("usableSelection", () => {
  it("drops a division that stopped being selectable while the console was open", () => {
    // The initial selection is computed once. A `router.refresh()` that freezes
    // a division under an open console would otherwise leave it unchecked in
    // the picker while the receipt still priced it and the run still sent it —
    // an over-quote, then a 409 SCHEDULE_LOCKED on the WHOLE run.
    const picker = pickerDivisions(DIVISIONS);
    expect(usableSelection(["d1", "d2", "d3", "d4"], picker)).toEqual(["d1", "d2"]);
    // An id the board no longer has at all goes too.
    expect(usableSelection(["d1", "gone"], picker)).toEqual(["d1"]);
  });
});

describe("DivisionChip", () => {
  it("truncates a long division name, as its board-grid twin does", () => {
    // Inside a 27rem dock, an untruncated chip pushes the row's own content out
    // of the panel. The grid's ghost chip already truncates; this one did not.
    const html = review({});
    const chips = [...html.matchAll(/<span[^>]*data-division-chip[^>]*>/g)].map((m) => m[0]);
    expect(chips.length).toBeGreaterThan(0);
    expect(chips.every((c) => /truncate/.test(c) && /min-w-0/.test(c))).toBe(true);
  });
});
