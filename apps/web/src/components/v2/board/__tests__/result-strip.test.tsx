import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ScheduleResultStrip } from "@/components/v2/board/result-strip";
import { DictProvider } from "@/components/i18n/dict-provider";
import uiEn from "@/dictionaries/en/ui.json";
import type { ScheduleMetrics, ScheduleSolverInfo } from "@/server/api-v1/schemas";

// Task 11 — the result strip is what makes the solver's ANYTIME contract honest
// to the organiser. It returns the best board found inside a time budget, which
// may be neither optimal nor complete, so every assertion below is about the
// strip refusing to imply a completeness the run did not deliver.
//
// Rendered with renderToStaticMarkup (no jsdom in this repo); useMsg() falls
// back to the English catalog outside a DictProvider, so the copy asserted here
// is the real dictionary copy, not a stand-in.
//
// DOM probes anchor on `="` — React serialises an omitted prop as
// `"$undefined"`, so a bare `data-tone` substring passes in both states.

const metrics = (over: Partial<ScheduleMetrics> = {}): ScheduleMetrics => ({
  // Deliberately three DIFFERENT durations so a swapped cell cannot pass.
  makespan_minutes: 260, // 4h 20m
  worst_idle_gap_minutes: 45,
  court_imbalance_minutes: 25,
  placed: 22,
  total: 22,
  ...over,
});

const solver = (over: Partial<ScheduleSolverInfo> = {}): ScheduleSolverInfo => ({
  engine: "z3",
  status: "ok",
  tiers_completed: 4,
  tiers_total: 4,
  budget_expired: false,
  elapsed_ms: 3200,
  moved: 6,
  ...over,
});

// React escapes `'` to `&#x27;` in text nodes. Decode it back so the copy
// assertions read as the copy; attribute delimiters are literal `"` either way,
// so the `="` anchoring below is unaffected.
const render = (m: ScheduleMetrics, s: ScheduleSolverInfo) =>
  renderToStaticMarkup(
    <DictProvider dict={uiEn} locale="en">
      <ScheduleResultStrip metrics={m} solver={s} />
    </DictProvider>,
  ).replace(/&#x27;/g, "'");

describe("ScheduleResultStrip — the numbers", () => {
  it("renders every metric against its OWN label, and the e2e testid", () => {
    const html = render(metrics(), solver());
    expect(html).toContain('data-testid="schedule-result-strip"');
    // Label -> value adjacency, not bare presence: transposing two cells must fail.
    expect(html).toMatch(/Total length<\/dt><dd[^>]*>4h 20m<\/dd>/);
    expect(html).toMatch(/Longest gap<\/dt><dd[^>]*>45m<\/dd>/);
    expect(html).toMatch(/Court spread<\/dt><dd[^>]*>25m<\/dd>/);
    expect(html).toMatch(/Scheduled<\/dt><dd[^>]*>22 \/ 22<\/dd>/);
  });

  it("reports the run's provenance in the organiser's words, never the engine key", () => {
    const html = render(metrics(), solver({ engine: "z3+lns", elapsed_ms: 3200, moved: 6 }));
    expect(html).toContain("Solver, then refined");
    expect(html).not.toContain("z3+lns");
    expect(html).toContain("3.2s");
    expect(html).toContain("6 matches moved");
  });

  it("says 'nothing moved' rather than '0 matches moved'", () => {
    const html = render(metrics(), solver({ moved: 0 }));
    expect(html).toContain("nothing moved");
    expect(html).not.toContain("0 matches moved");
  });

  /** A card that was never on the timetable cannot be MOVED. A re-flow over an
   *  unscheduled stage places the whole board, and "12 matches moved" is wrong
   *  about every single one of them. */
  it("says 'scheduled', not 'moved', when every card was placed for the first time", () => {
    const html = render(metrics(), solver({ moved: 12, seeded: 12 }));
    expect(html).toContain("12 matches scheduled");
    expect(html).not.toContain("12 matches moved");
  });

  /** The discriminator. Same `moved`, and `moved === placed` in this fixture
   *  too, so a component that inferred "was this seeded" from the metrics rather
   *  than reading `solver.seeded` would relabel this genuine re-flow as well. */
  it("keeps 'moved' for a re-flow that seeded nothing", () => {
    const html = render(metrics({ placed: 12, total: 12 }), solver({ moved: 12, seeded: 0 }));
    expect(html).toContain("12 matches moved");
    expect(html).not.toContain("12 matches scheduled");
  });

  /** A mixed run keeps the plain wording — it is the sentence that is true of
   *  the set as a whole, and a third string for a rare case is worse copy. */
  it("keeps 'moved' when only some of the cards were seeded", () => {
    const html = render(metrics(), solver({ moved: 12, seeded: 5 }));
    expect(html).toContain("12 matches moved");
    expect(html).not.toContain("12 matches scheduled");
  });

  /** BUILD and POLISH never send the field, and neither does a server one
   *  deploy behind. */
  it("keeps 'moved' when the wire carries no seeded count", () => {
    const html = render(metrics(), solver({ moved: 12 }));
    expect(html).toContain("12 matches moved");
  });
});

describe("ScheduleResultStrip — the anytime contract", () => {
  it("budget_expired: true names how far the solver got before it stopped", () => {
    const html = render(metrics(), solver({ budget_expired: true, tiers_completed: 2 }));
    expect(html).toContain('data-testid="schedule-result-budget"');
    expect(html).toContain("2 of 4 targets improved");
  });

  /** The denominator is the WIRE's, not a constant in the component. The
   *  fixture's 4 agrees with today's ladder, so the only way to tell the two
   *  apart is to send a value that does not: a component still reading its own
   *  `IMPROVEMENT_TARGETS` renders "2 of 4" here and is caught. */
  it("takes the target count from tiers_total rather than a hardcoded 4", () => {
    const html = render(metrics(), solver({ budget_expired: true, tiers_completed: 2, tiers_total: 7 }));
    expect(html).toContain("2 of 7 targets improved");
    expect(html).not.toContain("2 of 4 targets improved");
  });

  it("budget_expired: false does NOT render the note", () => {
    const html = render(metrics(), solver({ budget_expired: false, tiers_completed: 2 }));
    expect(html).not.toContain('data-testid="schedule-result-budget"');
    expect(html).not.toContain("targets improved");
  });

  it("already_optimal reads as a finished job, not a failure", () => {
    const html = render(metrics(), solver({ status: "already_optimal", moved: 0 }));
    expect(html).toContain("nothing left to improve");
    // Tone is the neutral one — an amber "something is wrong" band would be a lie.
    expect(html).toContain('data-tone="plain"');
    expect(html).not.toContain('data-tone="flag"');
  });

  it("solver_busy says the board is valid AND that a retry can do better", () => {
    // Contention here is ordinary and brief — one WASM solver instance per
    // machine, tens of seconds of wait — so it reads as a fact plus a retry,
    // never as an outage. The retry line is also the only thing that explains
    // why two runs on identical input can differ.
    const html = render(metrics(), solver({ status: "solver_busy", engine: "greedy" }));
    expect(html).toContain("the optimiser was busy");
    expect(html).toContain("Try again for a better board.");
    expect(html).toContain('data-tone="plain"');
  });

  it("z3_unavailable says the board is valid, and does NOT promise a retry will help", () => {
    const html = render(metrics(), solver({ status: "z3_unavailable", engine: "greedy" }));
    expect(html).toContain("the optimiser was not available");
    expect(html).toContain("The board is valid, just not optimised.");
    expect(html).not.toContain("Try again");
    expect(html).toContain('data-tone="plain"');
  });

  it("verifier_rejected is a neutral note — no blame, and no alarm colour", () => {
    const html = render(metrics(), solver({ status: "verifier_rejected", engine: "greedy" }));
    expect(html).toContain("Scheduled with the standard scheduler. The board is valid.");
    // The organiser cannot act on an internal fault, so nothing implies they
    // should: no amber band, and nothing pointing at their data or settings.
    expect(html).toContain('data-tone="plain"');
    expect(html).not.toContain('data-tone="flag"');
    expect(html).not.toMatch(/your (setup|settings|data)|check your/i);
  });
});

describe("ScheduleResultStrip — infeasible is a statement about the PINS", () => {
  // Measured on the engine lane: 20 clean fixtures + 2 contradictory pinned
  // cards returns 20 placed with exactly those 2 dropped. UNSAT is a proof about
  // the pins, so the strip must not tell the organiser their board is impossible.
  it("names the placement split and the pins, and never says the schedule is impossible", () => {
    const html = render(metrics({ placed: 20, total: 22 }), solver({ status: "infeasible" }));
    expect(html).toContain("20 of 22 scheduled");
    expect(html).toContain("2 pinned matches cannot all be kept where they are");
    expect(html).not.toMatch(/impossible|no schedule|cannot be scheduled/i);
    expect(html).toContain('data-tone="flag"');
  });

  it("uses the singular pin sentence when exactly one card was dropped", () => {
    const html = render(metrics({ placed: 21, total: 22 }), solver({ status: "infeasible" }));
    expect(html).toContain("one pinned match cannot be kept where it is");
    expect(html).not.toContain("pinned matches cannot all");
  });

  it("infeasible with a FULL board does not claim anything was dropped", () => {
    const html = render(metrics({ placed: 22, total: 22 }), solver({ status: "infeasible" }));
    expect(html).toContain("everything still found a slot");
    expect(html).not.toContain("scheduled —");
  });

  /**
   * THE case the `total - placed` fallback gets wrong, and the only shape that
   * can tell the two apart. Every spec above places the whole unplaced set at
   * the pins' door, so the derivation and the engine's own answer agree and a
   * test built on one of those boards proves nothing.
   *
   * Here four cards are off the board and the engine's proof names TWO of them:
   * the other two lost their slot to something else entirely. Telling the
   * organiser that four pins contradict each other sends them to unpin two cards
   * that were never the problem.
   */
  it("takes the pin count from the engine, not from total - placed", () => {
    const html = render(
      metrics({ placed: 18, total: 22 }),
      solver({ status: "infeasible", contradictory_pins: ["f-3", "f-7"] }),
    );
    expect(html).toContain("18 of 22 scheduled");
    expect(html).toContain("2 pinned matches cannot all be kept where they are");
    expect(html).not.toContain("4 pinned matches");
  });

  /** …and with no field on the wire it still says something, rather than going
   *  blank on the one board that most needs explaining. */
  it("falls back to total - placed when the engine named no pins", () => {
    const html = render(metrics({ placed: 18, total: 22 }), solver({ status: "infeasible" }));
    expect(html).toContain("4 pinned matches cannot all be kept where they are");
  });

  it("a partial board that is NOT infeasible says so without inventing pins", () => {
    const html = render(metrics({ placed: 20, total: 22 }), solver({ status: "ok" }));
    expect(html).toContain("20 of 22 scheduled");
    expect(html).toContain("2 matches could not be placed");
    expect(html).not.toContain("pinned");
    // The status sentence still gets said, on its own line.
    expect(html).toContain("These are the numbers the solver settled on.");
    expect(html).toContain('data-tone="flag"');
  });

  it("a complete board never renders the partial headline", () => {
    const html = render(metrics(), solver());
    expect(html).not.toContain("of 22 scheduled");
    expect(html).not.toContain("could not be placed");
  });
});
