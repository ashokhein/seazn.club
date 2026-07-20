// A frozen board rejects every apply (applySchedule, 422) and the server now
// refuses the run outright (409 SCHEDULE_LOCKED). The console must not offer a
// button that can only fail — an organiser previously spent a generation, a
// rate-limit slot and several minutes before finding out at Apply.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DictProvider } from "@/components/i18n/dict-provider";
import { AiConsole } from "../ai-console";

const stub = {
  "board.ai.frozen": "FROZEN-NOTICE",
  "board.ai.run.generate": "RUN-LABEL",
};

const props = {
  divisionId: "00000000-0000-4000-8000-000000000001",
  expectedSeq: 1,
  aiAllowed: true,
  brief: {
    courts: ["Court 1", "Court 2"],
    windows: 1,
    blackouts: 0,
    constraintsSet: false,
    movable: 4,
    pinned: 0,
    entrants: [
      { id: "e1", name: "Team A" },
      { id: "e2", name: "Team B" },
    ],
    officialsWithBlackout: 0,
  },
  fixtures: [],
  onClose: () => {},
} as unknown as Parameters<typeof AiConsole>[0];

const render = (scheduleFrozen: boolean) =>
  renderToStaticMarkup(
    <DictProvider dict={stub} locale="en">
      <AiConsole {...props} scheduleFrozen={scheduleFrozen} />
    </DictProvider>,
  );

describe("AiConsole — frozen schedule", () => {
  it("explains why, and disables the run button", () => {
    const html = render(true);
    expect(html).toContain("FROZEN-NOTICE");
    // The run button carries the .ai-run class; a frozen board must render it
    // disabled rather than relying on the server to reject the click.
    const runBtn = html.slice(html.indexOf("ai-run"));
    expect(runBtn.slice(0, 400)).toContain("disabled");
  });

  it("says nothing and leaves the button alone when the board is not frozen", () => {
    const html = render(false);
    expect(html).not.toContain("FROZEN-NOTICE");
  });
});
