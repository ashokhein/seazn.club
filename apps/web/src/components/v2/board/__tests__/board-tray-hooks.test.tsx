// The unscheduled tray needs a handle, because "the board repainted" is a
// statement about this component and nothing else.
//
// The open bug it exists to make assertable: after Auto-schedule + apply, the
// board has been observed rendering an empty grid with every card still docked
// here, while the result strip reports N of N scheduled and Postgres confirms
// the rows persisted. That is the client not repainting, and it does not
// self-correct. Until now the only handle on this tray was a translated
// `aria-label`, so no spec could say "every card left the tray" without
// asserting copy — which is banned on this surface (#465) and would red on a
// re-wording rather than on the defect.
//
// Two ids because the desktop dock and the mobile sheet BOTH render (the split
// is CSS, `lg:block` / `lg:hidden`), so one shared id would match twice and a
// 375px assertion would silently be answered by the desktop node.
//
// `data-count` rather than counting rendered blocks: it is the number the
// component itself is acting on, so it cannot agree with a body that failed to
// render. Anchored on `="` throughout — React serialises an omitted prop as the
// string "$undefined", so a bare presence probe passes in both states.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BoardTray } from "@/components/v2/board/board-tray";
import { DictProvider } from "@/components/i18n/dict-provider";
import uiEn from "@/dictionaries/en/ui.json";
import type { BoardDivision, BoardFixture } from "@/components/v2/board/types";

const DIVISION = { id: "d1", name: "Open", seq: 1 } as unknown as BoardDivision;

const card = (id: string): BoardFixture =>
  ({
    id,
    division_id: "d1",
    status: "scheduled",
    scheduled_at: null,
    court_label: null,
    schedule_locked: false,
    home_entrant_id: "e1",
    away_entrant_id: "e2",
  }) as unknown as BoardFixture;

const render = (unscheduled: BoardFixture[]) =>
  renderToStaticMarkup(
    <DictProvider dict={uiEn} locale="en">
      <BoardTray
        unscheduled={unscheduled}
        divisions={[DIVISION]}
        entrantNames={{ e1: "Alpha", e2: "Bravo" }}
        feedLabels={{}}
        conflictsByFixture={{}}
        canEdit
        pickedId={null}
        onPick={() => undefined}
        onTogglePin={() => undefined}
      />
    </DictProvider>,
  );

describe("BoardTray — the handle on 'did the board repaint'", () => {
  it("carries a testid and its own count on BOTH the dock and the sheet", () => {
    const html = render([card("f1"), card("f2"), card("f3")]);

    expect(html).toContain('data-testid="board-tray"');
    expect(html).toContain('data-testid="board-tray-mobile"');
    // The count is the assertable half: an id alone says the tray exists, which
    // is true of a tray holding one card and of a tray holding every card.
    expect(html.match(/data-count="3"/g) ?? []).toHaveLength(2);
  });

  it("renders nothing at all once every card has a slot", () => {
    const html = render([]);

    expect(html).toBe("");
  });
});
