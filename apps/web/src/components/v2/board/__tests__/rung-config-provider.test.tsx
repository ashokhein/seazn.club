// #385 — the client must price on the rung config the SERVER resolved.
//
// `envNumber` (lib/ai-rung.ts) reads `process.env[name]` with a COMPUTED key.
// Next replaces `process.env.FOO` by static substitution, and only for
// NEXT_PUBLIC_-prefixed names, so a computed lookup is never replaced at all:
// in a `"use client"` module every AI_RUNG_* override falls through to its
// fallback. The card therefore priced on defaults while the server priced on
// the overrides, and when an override RAISES a price that is a silent
// under-quote — the organiser charged more than the confirm card promised.
//
// THIS CLASS OF BUG IS INVISIBLE TO A SERVER-SIDE SUITE. Every vitest run has a
// working `process.env`, so calling `schedulingRungWeights()` in a test proves
// nothing about what a browser bundle would have read. The assertion therefore
// has to be on the value REACHING the card through the provider, never on the
// pure function's return.
//
// Rendering is `renderToStaticMarkup` — the repo's client-component convention;
// there is no jsdom or @testing-library in this workspace.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import type { Dict } from "@/lib/i18n-constants";
import { DictProvider } from "@/components/i18n/dict-provider";
import { officialsRungWeights, resolveRungConfig, type RungConfig } from "@/lib/ai-rung";
import en from "@/dictionaries/en/ui.json";
import { AiQuoteCard, type QuoteCardLine } from "../ai-quote-card";
import { RungConfigProvider, useRungConfig } from "../rung-config-provider";

const dict = en as unknown as Dict;
const enText = en as unknown as Record<string, string>;

function tEn(key: string, vars?: Record<string, string | number>): string {
  const raw = enText[key] ?? key;
  return vars ? raw.replace(/\{(\w+)\}/g, (m, n) => (n in vars ? String(vars[n]) : m)) : raw;
}

/** The card stamps its total on `data-ai-credits` — the number the organiser is
 *  told they will be charged. */
function creditsShown(html: string): number | null {
  const m = /data-ai-credits="(\d+)"/.exec(html);
  return m ? Number(m[1]) : null;
}

const LINE: QuoteCardLine = {
  key: "d1",
  label: null,
  input: { movableFixtures: 4, entrants: 8, courts: 2 },
  chosen: null,
};

function renderCard(config: RungConfig): string {
  return renderToStaticMarkup(
    <DictProvider dict={dict} locale="en">
      <RungConfigProvider value={config}>
        <AiQuoteCard lines={[LINE]} onChange={() => {}} msg={(k, v) => tEn(k as string, v)} busy={false} />
      </RungConfigProvider>
    </DictProvider>,
  );
}

describe("RungConfigProvider (#385)", () => {
  it("prices from the server-provided config, not from process.env", () => {
    // Weights a `"use client"` module could never have read for itself. A
    // four-fixture division is rung 1 under the defaults (score 12 <= 60) and
    // rung 3 under these (score 994 > s2 = 2), so the rendered total tells the
    // two sources apart with no ambiguity.
    const config: RungConfig = {
      scheduling: { entrantWeight: 99, courtWeight: 99, s1: 1, s2: 2, estTokensAtS1: 1, estTokensAtS2: 2 },
      officials: officialsRungWeights(),
      budgets: [32_000, 64_000, 128_000, 160_000, 192_000, 224_000],
    };
    expect(creditsShown(renderCard(config))).toBe(3);
  });

  it("keeps pricing on the defaults when the server resolved the defaults", () => {
    // The other half of the claim: the card is not simply always saying 3. Same
    // component, same line, the config a server with no overrides set produces.
    expect(creditsShown(renderCard(resolveRungConfig()))).toBe(1);
  });

  it("reads the token budget the server resolved, not its own table", () => {
    const config: RungConfig = {
      ...resolveRungConfig(),
      // A budget no default table produces, at the index a 1-credit run reads.
      budgets: [777_000, 64_000, 128_000, 160_000, 192_000, 224_000],
    };
    expect(renderCard(config)).toContain('data-ai-budget="777000"');
  });

  it("falls back past the end of the resolved table rather than rendering nothing", () => {
    // `budgets` holds 1..6 credits. #350's joint solve can price above that
    // (three rung-3 divisions total 9), and `cfg.budgets[n - 1]` is then
    // `undefined` — which `formatTokens` would render as "NaN" and the data
    // attribute would drop entirely. The tail fallback covers it.
    const config = resolveRungConfig();
    const three: QuoteCardLine[] = ["d1", "d2", "d3"].map((key) => ({
      key,
      label: key,
      input: { movableFixtures: 4, entrants: 8, courts: 2 },
      chosen: 3,
    }));
    const html = renderToStaticMarkup(
      <DictProvider dict={dict} locale="en">
        <RungConfigProvider value={config}>
          <AiQuoteCard lines={three} onChange={() => {}} msg={(k, v) => tEn(k as string, v)} busy={false} />
        </RungConfigProvider>
      </DictProvider>,
    );
    // rungTotal 9 → the budget the ladder's own table gives, not `undefined`.
    expect(html).toContain('data-ai-budget="320000"');
    expect(html).not.toContain("NaN");
    // And the run is still priced with the batch discount: max(1, 9 - 1).
    expect(creditsShown(html)).toBe(8);
  });

  it("throws rather than silently defaulting when no provider is mounted", () => {
    // This matters more than it looks. A `useContext` default value would
    // reintroduce exactly the silent-fallback failure this task exists to
    // remove: the card would price on defaults and say nothing about it.
    function Bare() {
      useRungConfig();
      return null;
    }
    expect(() => renderToStaticMarkup(<Bare />)).toThrow(/RungConfigProvider/);
  });
});

describe("every route that mounts the board seeds the config (#385)", () => {
  // A grep-and-wrap invites exactly one kind of miss: a second route that
  // mounts `ScheduleBoard` and is never wrapped. That is not a wrong price —
  // `useRungConfig` throws, so it is a blank page on a route nobody ran a unit
  // test against. Scanning the app directory means a route added later is
  // caught by this test rather than by an organiser.
  const APP = fileURLToPath(new URL("../../../../app", import.meta.url));

  function tsxFiles(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) tsxFiles(full, out);
      else if (e.name.endsWith(".tsx")) out.push(full);
    }
    return out;
  }

  const mounts = tsxFiles(APP).filter((f) => readFileSync(f, "utf8").includes("<ScheduleBoard"));

  it("finds the routes at all", () => {
    // Guards the scan itself: a renamed component or a moved app directory
    // would otherwise make every assertion below vacuously true.
    expect(mounts.length).toBeGreaterThanOrEqual(2);
  });

  it.each(mounts)("%s wraps the board in a RungConfigProvider", (file) => {
    const src = readFileSync(file, "utf8");
    expect(src).toContain("<RungConfigProvider value={resolveRungConfig()}>");
    // The board must be INSIDE it, not a sibling.
    expect(src.indexOf("<RungConfigProvider")).toBeLessThan(src.indexOf("<ScheduleBoard"));
    expect(src.indexOf("<ScheduleBoard")).toBeLessThan(src.indexOf("</RungConfigProvider>"));
  });
});

describe("resolveRungConfig (#385)", () => {
  it("carries both weight sets and a budget per credit 1..6", () => {
    const cfg = resolveRungConfig();
    expect(cfg.scheduling.s1).toBe(60);
    expect(cfg.officials.s1).toBe(120);
    // Index 0 is 1 credit — the off-by-one the card's `budgets[n - 1]` depends on.
    expect(cfg.budgets).toEqual([32_000, 64_000, 128_000, 160_000, 192_000, 224_000]);
  });
});
