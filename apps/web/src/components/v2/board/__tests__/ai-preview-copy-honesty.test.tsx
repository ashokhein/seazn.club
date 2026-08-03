// W5 (#400) Task 6b — the preview card may promise only what the system does.
//
// Two sentences on this card described an INTENTION rather than a behaviour,
// and both were traced to a mechanism that does something else:
//
//  * the soft-preference row. `parsed.soft` reaches exactly one consumer —
//    `schedule-ai-prompt.ts:135`, the architect's prompt — and never the
//    verifier. There is no court attribute concept in the engine and no
//    `HardConstraint` variant selects a court (#439, #440), so a clause like
//    "put the under-14s on the show court where families can watch" is
//    structurally unenforceable however clearly it is phrased. The token
//    `PREFER` read as *the system will try*, and beside a clause we cannot
//    model it read as *the system understood*. Neither is true.
//
//  * the failed-compile fallback. It offered to "send it as a preference —
//    the architect will read it, and nothing will check it". There is no
//    `as_preference` wire field: the fallback posts a run with NO `preview_id`,
//    and `schedule-ai.ts:2319` reads `confirmed === null` as compile-inline, so
//    stage 1 runs again and CAN produce hard constraints. The old copy promised
//    the opposite of what happens on the one path where the compiler chokes.
//
// The guards below are per-locale on purpose. A promise is made in the
// organiser's own language, so an English-only assertion would pass while a
// French organiser is still being told their sentence merely rides along.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Dict, Locale } from "@/lib/i18n-constants";
import { DictProvider } from "@/components/i18n/dict-provider";
import type { AiParsePreviewResponse } from "@/server/api-v1/schemas";
import { AiInstructionPreview } from "../ai-instruction-preview";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";

const enDict = en as Record<string, string>;

/** Locale, catalog, and the word that turns this card into a promise we do not
 *  keep: whatever "preference" is in that language. The failed-compile fallback
 *  does NOT run the sentence as a preference — it recompiles it — so the word
 *  must not appear in the copy that offers it. */
const DICTS: [Locale, Record<string, string>, RegExp][] = [
  ["en", enDict, /preference/i],
  ["es", es as Record<string, string>, /preferencia/i],
  ["fr", fr as Record<string, string>, /pr[ée]f[ée]rence/i],
  ["nl", nl as Record<string, string>, /voorkeur/i],
];

const SOFT_KEYS = [
  "board.ai.preview.soft.title",
  "board.ai.preview.soft.hint",
  "board.ai.preview.soft.token",
];
const FAILED_KEYS = ["board.ai.preview.failed.hint", "board.ai.preview.failed.asPreference"];

const withSoft: AiParsePreviewResponse = {
  preview_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  failed: false,
  compiled: {
    hard: [],
    soft: [{ note: "Put the under-14s on the show court where families can watch", weight: 2 }],
    unparsed: [],
    assumptions: [],
  },
  window: null,
  expires_at: "2026-08-10T12:00:00.000Z",
};

function render(dict: Record<string, string>, locale: Locale): string {
  return renderToStaticMarkup(
    <DictProvider dict={dict as unknown as Dict} locale={locale}>
      <AiInstructionPreview
        preview={withSoft}
        credits={2}
        onConfirm={() => {}}
        onDismiss={() => {}}
        onAsPreference={() => {}}
      />
    </DictProvider>,
  );
}

describe("the preview card names the mechanism, not the intention", () => {
  it.each(DICTS)("%s: the soft row has all three keys, translated", (locale, dict) => {
    for (const key of SOFT_KEYS) {
      expect(dict[key], `missing ${key}`).toBeTruthy();
      expect(dict[key]).not.toBe(key);
      if (locale !== "en") {
        expect(dict[key], `${locale} ${key} is an English placeholder`).not.toBe(enDict[key]);
      }
    }
  });

  it.each(DICTS)(
    "%s: the failed-compile fallback never calls the run a preference",
    (locale, dict, preference) => {
      for (const key of FAILED_KEYS) {
        expect(dict[key], `missing ${key}`).toBeTruthy();
        // The run it offers is a recompile, not a preference-only pass. Naming
        // it a preference is the promise the server does not keep.
        expect(dict[key], `${locale} ${key} still promises a preference-only run`).not.toMatch(
          preference,
        );
      }
    },
  );

  it("renders the soft token out of the catalog rather than a hardcoded PREFER", () => {
    const enHtml = render(enDict, "en");
    const [, frDict] = DICTS[2]!;
    const frHtml = render(frDict, "fr");
    // `PREFER` was hardcoded in the JSX, so it printed identically under every
    // catalog — the one row on this card an organiser most needs to read right.
    expect(enHtml).not.toContain(">PREFER<");
    expect(frHtml).not.toContain(">PREFER<");
    expect(enHtml).toContain(`>${enDict["board.ai.preview.soft.token"]}<`);
    expect(frHtml).toContain(`>${frDict["board.ai.preview.soft.token"]}<`);
    // Different catalogs, different token — an in-code string would fail this
    // while passing every en-only assertion.
    expect(frDict["board.ai.preview.soft.token"]).not.toBe(
      enDict["board.ai.preview.soft.token"],
    );
  });

  it("keeps the unenforceable note out of the enforced ledger entirely", () => {
    const html = render(enDict, "en");
    // The clause is on screen, and it is NOT a rule row: nothing downstream
    // checks it, so the card must not file it beside the ones that bind.
    expect(html).toContain("show court where families can watch");
    expect(html).not.toContain('data-preview-rule="hard"');
    expect(html.match(/data-preview-rule="soft"/g) ?? []).toHaveLength(1);
  });
});
