// Regression (v4 Task 13 review): the AI diff panel's blocking rows used to
// render the engine verifier's raw English (`c.detail || c.reason`), leaking
// English into fr/es/nl. They must localize through the board's shared
// `board.conflict.*` labels — mapping the engine reason token to its API code
// via the ONE REASON_CODE table — with the raw `detail` demoted to muted
// supplementary text. These pin the reason→dict-key helper and assert the
// rendered panel shows the localized label, never the raw engine string.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AiPlanResponse } from "@/server/api-v1/schemas";
import type { Dict, Locale } from "@/lib/i18n-constants";
import { DictProvider } from "@/components/i18n/dict-provider";
import { AiDiffPanel } from "../ai-diff-panel";
import { blockingConflictCode, blockingConflictKey, type AiConsoleFixture } from "../ai-diff";
import en from "@/dictionaries/en/ui.json";
import fr from "@/dictionaries/fr/ui.json";

const enDict = en as Record<string, string>;
const frDict = fr as Record<string, string>;

describe("blockingConflict* (reason → shared board.conflict.* labels)", () => {
  it("maps an engine reason token to its API code and dict key", () => {
    // court and (direct) order are the only reasons schedule-ai marks blocking.
    expect(blockingConflictCode("court")).toBe("conflict.court");
    expect(blockingConflictKey("court")).toBe("board.conflict.conflict.court");
    expect(blockingConflictCode("order")).toBe("warn.order");
    expect(blockingConflictKey("order")).toBe("board.conflict.warn.order");
  });

  it.each(["court", "order"])(
    "resolves a real localized label for blocking reason %s (never the raw token/key)",
    (reason) => {
      const key = blockingConflictKey(reason);
      for (const dict of [enDict, frDict]) {
        const label = dict[key];
        expect(label, `missing ${key}`).toBeTruthy();
        expect(label).not.toBe(key); // key is actually present in the catalog
        expect(label).not.toBe(reason); // not the raw engine token
      }
    },
  );

  it("falls an unmapped token through as its own pseudo-code (panel then uses its localized fallback, not the raw detail)", () => {
    expect(blockingConflictCode("totally_unknown")).toBe("totally_unknown");
    expect(blockingConflictKey("totally_unknown")).toBe("board.conflict.totally_unknown");
  });
});

const FIX = "11111111-1111-1111-1111-111111111111";
// One blocking row carrying the engine's raw camelCase reason + English detail.
const plan: AiPlanResponse = {
  proposal: [],
  unschedulable: [],
  warnings: [],
  blocking: [{ fixtureId: FIX, reason: "court", detail: "court Court 1 double-booked" }],
  diff: { moved: [], placed: [], unscheduled: [], unchanged: [] },
  explanations: [],
  summary: "Kept the court clear.",
  usage: { input_tokens: 10, output_tokens: 5, repair_rounds: 0 },
  officials_coverage: null,
};
const fixtures: AiConsoleFixture[] = [
  { id: FIX, scheduled_at: null, court_label: null, code: "SF1", matchup: "A vs B", isFinal: false, isJunior: false },
];

function renderPanel(dict: Record<string, string>, locale: Locale): string {
  return renderToStaticMarkup(
    <DictProvider dict={dict as unknown as Dict} locale={locale}>
      <AiDiffPanel plan={plan} fixtures={fixtures} excluded={[]} onToggleExclude={() => {}} />
    </DictProvider>,
  );
}

describe("AiDiffPanel blocking row localization", () => {
  it("renders the localized conflict label as the primary text (en)", () => {
    const html = renderPanel(enDict, "en");
    expect(html).toContain(enDict["board.conflict.conflict.court"]); // "court clash"
  });

  it("localizes the primary into fr — not the raw engine string", () => {
    const html = renderPanel(frDict, "fr");
    // The fr label proves the row no longer prints raw English as primary; a
    // revert to `c.detail || c.reason` would drop this and print the detail.
    expect(html).toContain(frDict["board.conflict.conflict.court"]); // "conflit de court"
    expect(frDict["board.conflict.conflict.court"]).not.toBe(
      enDict["board.conflict.conflict.court"],
    );
  });

  it("keeps the raw engine detail only as supplementary text", () => {
    const html = renderPanel(enDict, "en");
    expect(html).toContain("court Court 1 double-booked");
  });
});
