// #398 (W3 instruction compiler): the engine gained an `instruction` conflict
// reason and schedule-board maps it to the API code `warn.instruction`. Without
// a matching entry in the board's shared label/help tables — and in all four
// dictionaries — the conflicts panel renders the raw code at an organiser, on
// the ONE surface that tells them their own instruction was broken.
//
// The twin of conflict-window-copy.test.tsx (#397), deliberately kept as a
// separate file rather than folded into an every-REASON_CODE sweep:
// `conflict.start_window` is knowingly unlabelled.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Dict, Locale } from "@/lib/i18n-constants";
import { DictProvider } from "@/components/i18n/dict-provider";
import { ConflictsPanel } from "../conflicts-panel";
import { CONFLICT_HELP, CONFLICT_LABEL, type BoardConflict, type BoardFixture } from "../types";
import { REASON_CODE } from "@/lib/schedule-board";
import en from "@/dictionaries/en/ui.json";
import nl from "@/dictionaries/nl/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import es from "@/dictionaries/es/ui.json";

const DICTS: [Locale, Record<string, string>][] = [
  ["en", en as Record<string, string>],
  ["nl", nl as Record<string, string>],
  ["fr", fr as Record<string, string>],
  ["es", es as Record<string, string>],
];
const CODE = REASON_CODE.instruction; // "warn.instruction"

describe("warn.instruction organiser copy", () => {
  it("has a short label and a plain-English help in the shared fallback tables", () => {
    expect(CONFLICT_LABEL[CODE], `CONFLICT_LABEL[${CODE}]`).toBeTruthy();
    expect(CONFLICT_LABEL[CODE]).not.toBe(CODE);
    // Register of its neighbours: lowercase, no codes, no trailing stop.
    expect(CONFLICT_LABEL[CODE]).toBe(CONFLICT_LABEL[CODE]!.toLowerCase());
    expect(CONFLICT_LABEL[CODE]).not.toMatch(/[._]/);

    expect(CONFLICT_HELP[CODE], `CONFLICT_HELP[${CODE}]`).toBeTruthy();
    expect(CONFLICT_HELP[CODE]).toMatch(/\.$/); // a sentence, like its neighbours
    expect(CONFLICT_HELP[CODE]).not.toMatch(/warn\.|conflict\./); // no raw codes
  });

  it.each(DICTS)("has both keys, translated, in the %s catalog", (_locale, dict) => {
    for (const key of [`board.conflict.${CODE}`, `board.conflictHelp.${CODE}`]) {
      expect(dict[key], `missing ${key}`).toBeTruthy();
      expect(dict[key]).not.toBe(key);
    }
  });

  it("does not leave a non-en catalog on the English string", () => {
    const enDict = en as Record<string, string>;
    for (const [locale, dict] of DICTS) {
      if (locale === "en") continue;
      for (const key of [`board.conflict.${CODE}`, `board.conflictHelp.${CODE}`]) {
        expect(dict[key], `${locale} ${key} is an English placeholder`).not.toBe(enDict[key]);
      }
    }
  });
});

const FIX = "22222222-2222-2222-2222-222222222222";
const board: BoardFixture[] = [
  {
    id: FIX,
    stage_id: "st-1",
    division_id: "dv-1",
    round_no: 1,
    seq_in_round: 1,
    home_entrant_id: "en-a",
    away_entrant_id: "en-b",
    scheduled_at: "2026-09-01T10:00:00.000Z",
    venue: null,
    court_label: "Court 1",
    status: "scheduled",
    schedule_source: "manual",
    schedule_locked: false,
    outcome: null,
  },
];
const conflicts: BoardConflict[] = [{ fixture_id: FIX, code: CODE, blocking: false }];

function renderPanel(dict: Record<string, string>, locale: Locale): string {
  return renderToStaticMarkup(
    <DictProvider dict={dict as unknown as Dict} locale={locale}>
      <ConflictsPanel
        conflicts={conflicts}
        board={board}
        entrantNames={{ "en-a": "Alpha", "en-b": "Bravo" }}
        feedLabels={{}}
        divisionNames={{ "dv-1": "Div 1" }}
        onJump={() => {}}
        onClose={() => {}}
        checkFailed={false}
        checking={false}
        onRetryCheck={() => {}}
      />
    </DictProvider>,
  );
}

/** React escapes `'` to `&#x27;` etc., so a fr string like "à l'intérieur"
 *  never matches the raw catalog value. Compare on decoded text. */
function decode(html: string): string {
  return html
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

describe("ConflictsPanel renders a warn.instruction row in organiser language", () => {
  it.each(DICTS)("shows the localized label and help (%s), never the raw code", (locale, dict) => {
    const html = decode(renderPanel(dict, locale));
    expect(html).toContain(dict[`board.conflict.${CODE}`]);
    expect(html).toContain(dict[`board.conflictHelp.${CODE}`]);
    expect(html).not.toContain(CODE); // the raw `warn.instruction` never reaches the DOM
  });
});

// The badge sits in a fixed-width row beside a fixture name, and this label is
// the longest in CONFLICT_LABEL. Pinned so a future rewording cannot quietly
// push the 375px row into a horizontal scroll.
describe("warn.instruction label stays badge-sized", () => {
  it("is no longer than the longest label the panel already ships", () => {
    const others = Object.entries(CONFLICT_LABEL)
      .filter(([code]) => code !== CODE)
      .map(([, label]) => label.length);
    expect(CONFLICT_LABEL[CODE]!.length).toBeLessThanOrEqual(Math.max(...others) + 6);
  });
});
