// The proposal overlay on a MULTI-division board (#350 Task 8).
//
// The ghost blocks are the only place an organiser sees WHERE the AI wants to
// put things. On a competition board the same grid carries several divisions,
// and the real cards say which division they belong to — so a proposal that
// dropped that identity would repaint the board with anonymous blocks and make
// "did it starve one age group of the good slots?" unanswerable at a glance.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Dict } from "@/lib/i18n-constants";
import { DictProvider } from "@/components/i18n/dict-provider";
import en from "@/dictionaries/en/ui.json";
import { ghostBlocks } from "../schedule-board";
import { BoardGrid } from "../board/board-grid";
import type { AiConsoleFixture } from "../board/ai-diff";

const dict = en as unknown as Dict;

const fixture = (id: string, over: Partial<AiConsoleFixture> = {}): AiConsoleFixture => ({
  id,
  stage_id: "st-1",
  scheduled_at: "2026-08-01T09:00:00.000Z",
  court_label: "Court 1",
  code: `R1·${id}`,
  matchup: `${id} home vs ${id} away`,
  isFinal: false,
  isJunior: false,
  status: "scheduled",
  home_entrant_id: "e1",
  away_entrant_id: "e2",
  ...over,
});

const NAMES = { d1: "Under 12s", d2: "Under 14s" };

describe("ghostBlocks", () => {
  it("names the division each proposed placement belongs to", () => {
    // The two placements are in DIFFERENT divisions, so a derivation that
    // stamped every ghost with the first division's name would still be wrong
    // here — which a single-division fixture set could not show.
    const blocks = ghostBlocks(
      {
        proposal: [
          { fixture_id: "f1", scheduled_at: "2026-08-01T09:00:00.000Z", court_label: "Court 1", division_id: "d1" },
          { fixture_id: "f2", scheduled_at: "2026-08-01T10:00:00.000Z", court_label: "Court 2", division_id: "d2" },
        ],
        blocking: [],
      },
      [fixture("f1"), fixture("f2")],
      NAMES,
      [],
    );
    expect(blocks.map((b) => b.division)).toEqual([
      { id: "d1", name: "Under 12s" },
      { id: "d2", name: "Under 14s" },
    ]);
  });

  it("leaves a single-division proposal's ghosts unattributed", () => {
    // The division board's own console sends no `division_id` — one division
    // means the label would be the same on every block and carry no
    // information, so it must not appear at all.
    const blocks = ghostBlocks(
      {
        proposal: [
          { fixture_id: "f1", scheduled_at: "2026-08-01T09:00:00.000Z", court_label: "Court 1" },
        ],
        blocking: [],
      },
      [fixture("f1")],
      NAMES,
      [],
    );
    expect(blocks[0].division).toBeNull();
  });

  it("paints a blocked placement red whatever its diff bucket says", () => {
    // f1 does not move, so its bucket is `unchanged` (dimmed). Being blocked has
    // to win, or a caught conflict reads as a tidy no-op.
    const blocks = ghostBlocks(
      {
        proposal: [
          { fixture_id: "f1", scheduled_at: "2026-08-01T09:00:00.000Z", court_label: "Court 1", division_id: "d1" },
        ],
        blocking: [{ fixtureId: "f1" }],
      },
      [fixture("f1")],
      NAMES,
      [],
    );
    expect(blocks[0].tone).toBe("blocking");
  });
});

describe("the grid's ghost block", () => {
  const grid = (division: { id: string; name: string } | null) =>
    renderToStaticMarkup(
      <DictProvider dict={dict} locale="en">
        <BoardGrid
          day="2026-08-01"
          slots={[new Date("2026-08-01T09:00:00.000Z").getTime()]}
          slotMinutes={30}
          courts={["Court 1"]}
          fixtures={[]}
          divisionNames={NAMES}
          entrantNames={{}}
          feedLabels={{}}
          conflictsByFixture={{}}
          canEdit={false}
          multi
          pickedId={null}
          onPick={() => {}}
          onPlace={() => {}}
          onDropCard={() => {}}
          onTogglePin={() => {}}
          venueCap="Court"
          highlightId={null}
          ghosts={[
            {
              id: "f1",
              code: "R1·1",
              matchup: "Ada vs Bea",
              isFinal: false,
              isJunior: false,
              at: new Date("2026-08-01T09:00:00.000Z").getTime(),
              court: "Court 1",
              tone: "placed",
              division,
            },
          ]}
        />
      </DictProvider>,
    );

  it("shows the division on a joint proposal and nothing on a single-division one", () => {
    expect(grid({ id: "d1", name: "Under 12s" })).toContain("Under 12s");
    expect(grid(null)).not.toContain("Under 12s");
  });
});
