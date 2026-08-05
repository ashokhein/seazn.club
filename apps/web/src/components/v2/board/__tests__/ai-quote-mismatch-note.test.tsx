// #387 — the receipt correction line, and the field that makes it possible.
//
// Two halves, and both have to hold or the feature measures nothing:
//   1. the RUN BODY carries the number the confirm card showed, so the server
//      has something to compare its charge against;
//   2. the RESULT SURFACE says so when they disagreed — in BOTH directions,
//      because an over-charge and an under-charge are different news.
//
// The comparison itself is server-side and is proved in
// server/usecases/__tests__/ai-quote-mismatch.test.ts. Nothing here recomputes
// it: a client that decided for itself whether the numbers matched could agree
// with itself while disagreeing with the invoice.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Dict } from "@/lib/i18n-constants";
import { DictProvider } from "@/components/i18n/dict-provider";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";
import { AiQuoteMismatchNote } from "../ai-quote-card";
import { officialsPlanBody, schedulePlanBody } from "../ai-console";
import { initialAiConsoleState } from "../ai-console-state";

const dict = en as unknown as Dict;
const enText = en as unknown as Record<string, string>;

function tEn(key: string, vars?: Record<string, string | number>): string {
  const raw = enText[key] ?? key;
  return vars ? raw.replace(/\{(\w+)\}/g, (m, n) => (n in vars ? String(vars[n]) : m)) : raw;
}

function render(mismatch: { quoted: number; charged: number } | undefined): string {
  return renderToStaticMarkup(
    <DictProvider dict={dict} locale="en">
      <AiQuoteMismatchNote mismatch={mismatch} msg={(k, v) => tEn(k as string, v)} />
    </DictProvider>,
  );
}

describe("the receipt correction line (#387)", () => {
  it("says so when the organiser was charged MORE than the card quoted", () => {
    const html = render({ quoted: 1, charged: 3 });
    // Direction is on the element, so a tone change cannot silently swap which
    // case gets the amber treatment.
    expect(html).toContain('data-ai-quote-mismatch="over"');
    expect(html).toContain("Quoted 1, charged 3");
    expect(html).toContain("more than the estimate");
    // The card's existing caution vocabulary — this is the complaint-shaped
    // direction, and it reads as part of the receipt rather than a new alert.
    expect(html).toContain("amber");
    expect(html).toContain('role="status"');
  });

  it("says so when they were charged LESS, quietly", () => {
    const html = render({ quoted: 3, charged: 1 });
    expect(html).toContain('data-ai-quote-mismatch="under"');
    expect(html).toContain("Quoted 3, charged 1");
    expect(html).toContain("less than the estimate");
    // Not amber: alarming someone about money they did not spend trains them to
    // stop reading the amber one.
    expect(html).not.toContain("amber");
  });

  it("renders nothing at all when the card and the charge agreed", () => {
    expect(render(undefined)).toBe("");
  });

  it("carries both copy keys in all four locales", () => {
    for (const [locale, d] of [
      ["en", en],
      ["es", es],
      ["fr", fr],
      ["nl", nl],
    ] as const) {
      const flat = d as unknown as Record<string, string>;
      for (const key of ["board.ai.quote.mismatchOver", "board.ai.quote.mismatchUnder"]) {
        expect(flat[key], `${locale} ${key}`).toBeTruthy();
        // Both figures interpolate, or the line names one number and leaves the
        // reader to guess the other.
        expect(flat[key], `${locale} ${key}`).toContain("{quoted}");
        expect(flat[key], `${locale} ${key}`).toContain("{charged}");
      }
      if (locale !== "en") {
        // Never leave English sitting in the other three files.
        expect(flat["board.ai.quote.mismatchOver"]).not.toBe(enText["board.ai.quote.mismatchOver"]);
        expect(flat["board.ai.quote.mismatchUnder"]).not.toBe(enText["board.ai.quote.mismatchUnder"]);
      }
    }
  });
});

describe("the run bodies carry the quote (#387)", () => {
  const state = initialAiConsoleState;

  it("sends quoted_credits on the schedule path when the card showed one", () => {
    const body = schedulePlanBody(state, { instruction: "plan it", mode: "generate", quotedCredits: 2 });
    expect(body.quoted_credits).toBe(2);
  });

  it("sends quoted_credits on the officials path when the card showed one", () => {
    const body = officialsPlanBody(state, {
      instruction: "",
      schedule: [],
      policy: { roles: ["referee"] } as never,
      quotedCredits: 1,
    });
    expect(body.quoted_credits).toBe(1);
  });

  it("OMITS the key entirely when no card was on screen", () => {
    // Absence is silence, not "quoted zero" — the server must not file a
    // mismatch against a caller that never quoted anything. A `quoted_credits:
    // undefined` on the wire would serialise away, but the key must not be
    // there at all for the same reason `rung` is not: what is sent is what is
    // asserted on.
    const schedule = schedulePlanBody(state, { instruction: "plan it", mode: "generate" });
    expect("quoted_credits" in schedule).toBe(false);
    const officials = officialsPlanBody(state, {
      instruction: "",
      schedule: [],
      policy: { roles: ["referee"] } as never,
    });
    expect("quoted_credits" in officials).toBe(false);
  });
});
