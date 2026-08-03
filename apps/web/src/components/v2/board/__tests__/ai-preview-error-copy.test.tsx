// W5 (#400) — a failed COMPILE has to say something, and leave a way out.
//
// The preview is the cheap half of the gate: it compiles the organiser's
// sentence for free so they can read the rules before paying to run against
// them. That makes its failure modes load-bearing rather than edge cases — 402
// (empty wallet), 409, 429, 5xx and offline all land here, and the organiser's
// only signal was a spinner that stopped.
//
// The cause was a state coupling no render test could see: `PREVIEW_ERROR`
// stores the error but deliberately does NOT set `run` (that field describes
// the architect run, and a free compile never started one), while the brief
// step's error block was gated on `state.run === "error"`. Every preview
// failure therefore rendered nothing at all. This suite pins the block on the
// preview's own status, in every language, and pins that the retry the
// organiser needs is still on screen underneath it.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Dict, Locale } from "@/lib/i18n-constants";
import { DictProvider } from "@/components/i18n/dict-provider";
import { BriefStep } from "../ai-console";
import { initialAiConsoleState, type AiConsoleState } from "../ai-console-state";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";

const DICTS: Record<Locale, Record<string, string>> = {
  en: en as Record<string, string>,
  es: es as Record<string, string>,
  fr: fr as Record<string, string>,
  nl: nl as Record<string, string>,
};
const enDict = DICTS.en;

const DIVISION = "00000000-0000-4000-8000-000000000001";

/** Copy in these catalogs is full of apostrophes ("Couldn't finish.", "You're
 *  out of AI credits"), and React escapes them into the markup. Asserting the
 *  raw catalog string would fail against a correct render — and, worse, a
 *  NEGATIVE assertion written that way passes no matter what is on screen. */
const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#x27;",
};
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ESCAPES[c]!);
/** The escaped copy for `key` in `locale`, or a loud failure if it is missing. */
function t(key: string, locale: Locale = "en"): string {
  const raw = DICTS[locale][key];
  if (!raw) throw new Error(`${locale} catalog is missing ${key}`);
  return esc(raw);
}

const brief = {
  courts: ["Court 1", "Court 2"],
  windows: 1,
  blackouts: 0,
  constraintsSet: false,
  movableFixtures: [
    { id: "f1", scheduled_at: "2026-08-01T10:00:00.000Z", court_label: "Court 1" },
  ],
  pinned: 0,
  entrants: [
    { id: "e1", name: "Team A" },
    { id: "e2", name: "Team B" },
  ],
  activeEntrants: 2,
  officialsWithBlackout: 0,
};

const preflight = {
  divisionId: DIVISION,
  courts: 2,
  windows: 1,
  blackouts: 0,
  constraintsSet: false,
  movable: 1,
  pinned: 0,
  officials: 0,
  officialsBlackout: 0,
  settingsHref: "/divisions/d1/schedule?tab=settings",
  officialsHref: "/divisions/d1/schedule?tab=officials",
};

/** The step takes `msg` as a prop; resolve against the real dictionary so a
 *  missing key renders as the key itself rather than silently passing. */
function formatter(dict: Record<string, string>) {
  return (key: string, vars?: Record<string, string | number>): string => {
    const raw = dict[key] ?? key;
    return vars
      ? raw.replace(/\{(\w+)\}/g, (m, n: string) => (n in vars ? String(vars[n]) : m))
      : raw;
  };
}

/**
 * A console whose compile failed, exactly as `PREVIEW_ERROR` leaves it: the
 * brief still on screen, no preview slice, `run` untouched at "idle", and the
 * localized message the console resolved through `aiErrorKey`.
 */
function failedCompile(locale: Locale, key: string, status: number): AiConsoleState {
  return {
    ...initialAiConsoleState,
    instruction: "at most 2 matches a day",
    preview: { status: "error", data: null, id: null, asPreference: false, instruction: null },
    error: { status, message: DICTS[locale][key] ?? key, key },
  };
}

function render(state: AiConsoleState, locale: Locale = "en"): string {
  const dict = DICTS[locale];
  const msg = formatter(dict);
  return renderToStaticMarkup(
    <DictProvider dict={dict as unknown as Dict} locale={locale}>
      <BriefStep
        state={state}
        dispatch={() => {}}
        run={() => {}}
        preview={() => {}}
        busy={false}
        msg={msg as never}
        currency="usd"
        brief={brief as never}
        preflight={preflight}
        wishes={[]}
        onWishes={() => {}}
        onFill={() => {}}
        lastRun={null}
        scheduleFrozen={false}
      />
    </DictProvider>,
  );
}

describe("BriefStep — a failed compile is spoken, not swallowed", () => {
  it("says what went wrong when the compile is rate limited", () => {
    const html = render(failedCompile("en", "board.ai.error.rateLimited", 429));
    // The server's own reason, localized — not a raw status and not silence.
    expect(html).toContain(t("board.ai.error.rateLimited"));
    expect(html).toContain('role="alert"');
    // Named as a failed CHECK. "Couldn't finish." is the run's line, and the
    // run is the one thing that did not happen here.
    expect(html).toContain(t("board.ai.preview.error.label"));
    expect(html).not.toContain(t("board.ai.errorLabel"));
    // The fact the whole gate exists to make true: the check is free, so a
    // failed check costs nothing.
    expect(html).toContain(t("board.ai.preview.error.free"));
  });

  it("leaves the check itself on screen and enabled, so the failure is not a dead end", () => {
    const html = render(failedCompile("en", "board.ai.errorGeneric", 500));
    expect(html).toContain(t("board.ai.errorGeneric"));
    // Still the CHECK stage (nothing was compiled, so nothing is armed to run)
    // and still clickable — a disabled button under an error is a dead end.
    expect(html).toContain('data-ai-stage="check"');
    // `disabled=""`, not the bare word: the button's own class list carries
    // `disabled:cursor-not-allowed` and `disabled:opacity-50`, so a substring
    // probe reports every enabled button as disabled.
    expect(html).not.toMatch(/data-ai-stage="check"[^>]*disabled=""/);
    expect(html).toContain(t("board.ai.preview.check"));
    // The discriminator for the line above: a button this markup CAN disable
    // (empty brief) does match, so the negative assertion is reading the real
    // attribute rather than passing on its own shape.
    const empty = render({ ...initialAiConsoleState, instruction: "" });
    expect(empty).toMatch(/data-ai-stage="check"[^>]*disabled=""/);
  });

  it("offers the top-up recovery when the wallet is empty at the check", () => {
    const html = render(failedCompile("en", "board.ai.error.outOfCredits", 402));
    // The SAME A6 block a failed run shows — one out-of-credits state on this
    // console, not a second one written for the preview.
    expect(html).toContain(t("board.ai.error.outOfCreditsTitle"));
    expect(html).toContain(t("board.ai.error.outOfCredits"));
    expect(html).toContain('data-upgrade="pro_plus"');
    // The plain red line is the alternative branch, never both.
    expect(html).not.toContain(t("board.ai.preview.error.label"));
  });

  it("still reads as a run failure when it was the run that failed", () => {
    // Regression guard on the branch that already worked: widening the gate
    // must not relabel an architect failure as a failed check.
    const html = render({
      ...initialAiConsoleState,
      instruction: "at most 2 matches a day",
      run: "error",
      error: { status: 500, message: enDict["board.ai.errorGeneric"]!, key: "board.ai.errorGeneric" },
    });
    expect(html).toContain(t("board.ai.errorLabel"));
    expect(html).not.toContain(t("board.ai.preview.error.label"));
  });

  it("says nothing when nothing has failed", () => {
    const html = render({ ...initialAiConsoleState, instruction: "at most 2 matches a day" });
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain(t("board.ai.preview.error.label"));
  });

  // Per-locale on purpose: an organiser reads this in their own language, and
  // an English placeholder in es/fr/nl is exactly the failure "nothing is said"
  // becomes once the block renders at all.
  it.each(["es", "fr", "nl"] as const)("speaks %s, not English", (locale) => {
    const dict = DICTS[locale];
    for (const key of ["board.ai.preview.error.label", "board.ai.preview.error.free"]) {
      expect(dict[key], `${locale} is missing ${key}`).toBeTruthy();
      expect(dict[key], `${locale} left ${key} in English`).not.toBe(enDict[key]);
    }
    const html = render(failedCompile(locale, "board.ai.error.rateLimited", 429), locale);
    expect(html).toContain(t("board.ai.preview.error.label", locale));
    expect(html).toContain(t("board.ai.preview.error.free", locale));
    expect(html).toContain(t("board.ai.error.rateLimited", locale));
  });
});
