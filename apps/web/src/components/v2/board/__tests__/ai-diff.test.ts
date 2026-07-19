// Client-side schedule diff (v4 Task 13). The engine's verified proposal ships a
// server `diff` (id arrays); the panel needs the same buckets enriched with
// from→to provenance to render the "why it did that" list and colour the grid
// ghosts. computeAiDiff is the pure recomputation — asserted here to bucket the
// same ids the server did (a regression guard on the client/server contract) and
// to carry the correct current→proposed slots.
import { describe, expect, it } from "vitest";
import type { AiPlanResponse } from "@/server/api-v1/schemas";
import { computeAiDiff, ghostToneFor, type AiFixtureRef } from "../ai-diff";

// Four fixtures, one per bucket:
//  - MOVE  was Court 2 · 13:30  → Court 1 · 14:00
//  - PLACE was unscheduled (tray) → Court 2 · 13:30
//  - DROP  was Court 1 · 15:00  → not in proposal (falls to the tray)
//  - KEEP  Court 1 · 13:00 unchanged
const MOVE = "11111111-1111-1111-1111-111111111111";
const PLACE = "22222222-2222-2222-2222-222222222222";
const DROP = "33333333-3333-3333-3333-333333333333";
const KEEP = "44444444-4444-4444-4444-444444444444";

const current: AiFixtureRef[] = [
  { id: MOVE, scheduled_at: "2026-08-01T13:30:00+01:00", court_label: "Court 2" },
  { id: PLACE, scheduled_at: null, court_label: null },
  { id: DROP, scheduled_at: "2026-08-01T15:00:00+01:00", court_label: "Court 1" },
  { id: KEEP, scheduled_at: "2026-08-01T13:00:00+01:00", court_label: "Court 1" },
];

const plan: AiPlanResponse = {
  proposal: [
    { fixture_id: MOVE, scheduled_at: "2026-08-01T14:00:00+01:00", court_label: "Court 1" },
    { fixture_id: PLACE, scheduled_at: "2026-08-01T13:30:00+01:00", court_label: "Court 2" },
    { fixture_id: KEEP, scheduled_at: "2026-08-01T13:00:00+01:00", court_label: "Court 1" },
  ],
  unschedulable: [],
  warnings: [],
  blocking: [],
  // Server truth — computeAiDiff must bucket exactly these ids.
  diff: { moved: [MOVE], placed: [PLACE], unscheduled: [DROP], unchanged: [KEEP] },
  explanations: [],
  summary: "Placed the tray fixture and nudged the semi to keep the court clear.",
  usage: { input_tokens: 1240, output_tokens: 860, repair_rounds: 1 },
  officials_coverage: null,
};

describe("computeAiDiff", () => {
  const diff = computeAiDiff(plan, current);

  it("puts each fixture in exactly one bucket", () => {
    expect(diff.moved.map((m) => m.fixture_id)).toEqual([MOVE]);
    expect(diff.placed.map((p) => p.fixture_id)).toEqual([PLACE]);
    expect(diff.unscheduled.map((u) => u.fixture_id)).toEqual([DROP]);
    expect(diff.unchanged.map((u) => u.fixture_id)).toEqual([KEEP]);
  });

  it("bucket membership matches the server diff exactly", () => {
    expect(diff.moved.map((m) => m.fixture_id).sort()).toEqual([...plan.diff.moved].sort());
    expect(diff.placed.map((p) => p.fixture_id).sort()).toEqual([...plan.diff.placed].sort());
    expect(diff.unscheduled.map((u) => u.fixture_id).sort()).toEqual([...plan.diff.unscheduled].sort());
    expect(diff.unchanged.map((u) => u.fixture_id).sort()).toEqual([...plan.diff.unchanged].sort());
  });

  it("carries from→to provenance on a move", () => {
    expect(diff.moved[0]).toEqual({
      fixture_id: MOVE,
      from: { scheduled_at: "2026-08-01T13:30:00+01:00", court_label: "Court 2" },
      to: { scheduled_at: "2026-08-01T14:00:00+01:00", court_label: "Court 1" },
    });
  });

  it("a placed fixture carries only its destination", () => {
    expect(diff.placed[0]).toEqual({
      fixture_id: PLACE,
      to: { scheduled_at: "2026-08-01T13:30:00+01:00", court_label: "Court 2" },
    });
  });

  it("an unscheduled fixture carries only where it left", () => {
    expect(diff.unscheduled[0]).toEqual({
      fixture_id: DROP,
      from: { scheduled_at: "2026-08-01T15:00:00+01:00", court_label: "Court 1" },
    });
  });

  it("treats a same-instant / same-court proposal as unchanged even if the ISO string differs", () => {
    const restated: AiPlanResponse = {
      ...plan,
      proposal: [{ fixture_id: KEEP, scheduled_at: "2026-08-01T12:00:00Z", court_label: "Court 1" }],
      diff: { moved: [], placed: [], unscheduled: [MOVE, DROP], unchanged: [KEEP] },
    };
    const d = computeAiDiff(restated, current);
    expect(d.moved).toEqual([]);
    expect(d.unchanged.map((u) => u.fixture_id)).toEqual([KEEP]);
  });
});

describe("ghostToneFor", () => {
  const diff = computeAiDiff(plan, current);
  const blocking = new Set<string>();

  it("maps each bucket to its state-palette tone", () => {
    expect(ghostToneFor(MOVE, diff, blocking)).toBe("moved");
    expect(ghostToneFor(PLACE, diff, blocking)).toBe("placed");
    expect(ghostToneFor(KEEP, diff, blocking)).toBe("unchanged");
  });

  it("blocking wins over the diff bucket (red trumps amber/teal)", () => {
    expect(ghostToneFor(MOVE, diff, new Set([MOVE]))).toBe("blocking");
  });
});
