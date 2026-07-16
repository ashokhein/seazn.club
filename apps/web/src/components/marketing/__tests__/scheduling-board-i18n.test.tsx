import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SchedulingBoard } from "../scheduling-board";
import { DictProvider } from "@/components/i18n/dict-provider";

// Static render lands in attract/replay mode (effects don't run), so we assert
// the replay caption comes from the provided dict — proof the board reads its
// copy from the `marketing` catalog rather than hardcoded English. Interaction
// copy (statuses, court labels) is covered by e2e/marketing-scheduling.spec.ts.
const stub = {
  "sched.board.fixture.1": "A v B",
  "sched.board.fixture.2": "C v D",
  "sched.board.fixture.3": "E v F",
  "sched.board.status.initial": "INIT-XX",
  "sched.board.replayCaption": "REPLAY-CAPTION-XX",
};

describe("SchedulingBoard i18n", () => {
  it("renders the replay caption from the dict", () => {
    const html = renderToStaticMarkup(
      <DictProvider dict={stub} locale="fr">
        <SchedulingBoard />
      </DictProvider>,
    );
    expect(html).toContain("REPLAY-CAPTION-XX");
    expect(html).not.toContain("TOUCH TO TAKE OVER");
  });
});
