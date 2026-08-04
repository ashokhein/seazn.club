// core.award rendering: the canonical engine payload is { person, key }
// (Jul3/07 §4) — the feed showed "Awarded to Unknown" for every MOTM because
// the renderer read a `to` field that only legacy rows carry.
//
// Gap 2: describeEvent authored its own English. It was the second
// unlocalized scoring surface (the first, the scorer's error banner, became
// `scoringErrorText`), and it hardcoded a SECOND set of names for event types
// that `scoring-vocab.ts` already translates in four locales. Two label
// sources for one event type drift, and the drift is invisible because both
// render something plausible — so every noun here now comes from
// scoring-vocab and only the sentence frames are event-copy's own.
import { describe, expect, it } from "vitest";
import { describeEvent, EVENT_COPY_KEYS } from "../event-copy";
import { EVENT_KEY, type MsgFn } from "@/lib/scoring-vocab";
import { builtinModules } from "@seazn/engine/sports";
import uiEn from "@/dictionaries/en/ui.json";
import uiEs from "@/dictionaries/es/ui.json";
import uiFr from "@/dictionaries/fr/ui.json";
import uiNl from "@/dictionaries/nl/ui.json";

const NAMES = { p1: "Ashokkumar K S", e1: "Lions U12" };
const LOCALES = {
  en: uiEn as Record<string, string>,
  es: uiEs as Record<string, string>,
  fr: uiFr as Record<string, string>,
  nl: uiNl as Record<string, string>,
};
const at = (l: keyof typeof LOCALES): MsgFn => (k) => LOCALES[l][k];
const en = at("en");
const fr = at("fr");
/** Stub translator: echoes the key, so we can prove copy came from a key. */
const echo: MsgFn = (k) => `«${k}»`;

interface TieredModule {
  key: string;
  fidelityTiers?: readonly { eventTypes: readonly string[] }[];
}

/** Every event type any shipped module declares — read from the engine, not
 *  hand-copied, so a wave that adds a type reds this file until copy lands. */
function declaredEventTypes(): string[] {
  const out = new Set<string>(Object.keys(EVENT_KEY).filter((k) => k.startsWith("core.")));
  for (const m of builtinModules as unknown as TieredModule[]) {
    for (const tier of m.fidelityTiers ?? []) for (const t of tier.eventTypes) out.add(t);
  }
  return [...out].sort();
}

/**
 * One representative payload per event type. Deliberately NOT exhaustive on
 * fields — the point is to reach the branch, not to pin the sentence. Types
 * with no entry get `{}`, which is itself a case worth rendering.
 */
const SAMPLES: Record<string, Record<string, unknown>> = {
  "core.note": { text: "Crowd noise" },
  "core.forfeit": { by: "e1", reason: "weather" },
  "core.abandon": { reason: "rain" },
  "core.award": { person: "p1", key: "motm" },
  "football.goal": { by: "p1", minute: 21, penalty: true },
  "football.card": { by: "p1", minute: 63, color: "second_yellow" },
  "football.period": { phase: "ET_H1" },
  "football.shootout.kick": { by: "p1", scored: false },
  "football.sub": { by: "p1" },
  "boardgame.result": { winner: "p1", method: "checkmate" },
  "generic.result": { p1Score: 3, p2Score: 1 },
  "volleyball.set.summary": { home: 25, away: 22 },
  "badminton.game.summary": { home: 21, away: 19, partial: true },
  "volleyball.rally": { wonBy: "e1" },
};
const sample = (type: string) => SAMPLES[type] ?? {};

describe("describeEvent core.award", () => {
  it("renders MOTM from the canonical { person, key } payload", () => {
    const d = describeEvent("core.award", { person: "p1", key: "motm" }, NAMES, en);
    expect(d.label).toBe("Award");
    expect(d.text).toBe("Man of the Match — Ashokkumar K S");
    expect(d.tone).toBe("admin");
  });

  it("prettifies other award keys", () => {
    const d = describeEvent("core.award", { person: "p1", key: "player_of_series" }, NAMES, en);
    expect(d.text).toBe("Player of series — Ashokkumar K S");
  });

  it("keeps the legacy { to } fallback working", () => {
    const d = describeEvent("core.award", { to: "e1" }, NAMES, en);
    expect(d.text).toContain("Lions U12");
  });

  it("degrades to Unknown only when the id is truly absent from the map", () => {
    const d = describeEvent("core.award", { person: "ghost", key: "motm" }, NAMES, en);
    expect(d.text).toBe("Man of the Match — Unknown");
  });

  it("names the award in the reader's language, from the shared vocabulary", () => {
    // Same award key the player-stat rows use — one translation, two surfaces.
    expect(describeEvent("core.award", { person: "p1", key: "motm" }, NAMES, fr).text)
      .toBe(`${uiFr["award.motm"]} — Ashokkumar K S`);
    expect(uiFr["award.motm"]).not.toBe(uiEn["award.motm"]);
  });
});

describe("the activity feed authors no English of its own", () => {
  it("reaches the engine's declarations and its own key set", () => {
    // Vacuity guards. Both loops below iterate derived sets; an empty one would
    // make them pass while proving nothing.
    const types = declaredEventTypes();
    expect(types.length).toBeGreaterThanOrEqual(55);
    expect(types).toContain("football.goal");
    expect(types).toContain("cricket.ball");
    expect(types).toContain("volleyball.set.summary");
    expect(EVENT_COPY_KEYS.length).toBeGreaterThanOrEqual(10);
    // And prove the fr dictionary is actually loaded and differs from en, or
    // every "not English" assertion below is vacuously satisfied by two
    // identical tables.
    expect(uiFr["event.football.goal"]).not.toBe(uiEn["event.football.goal"]);
  });

  it("sources every badge from a message key, for every declared event type", () => {
    // The structural pin: with an echoing translator NO badge may survive as
    // prose. A reintroduced string literal reds here on the type that carries
    // it, whether or not anyone remembered to translate it.
    for (const type of declaredEventTypes()) {
      const d = describeEvent(type, sample(type), NAMES, echo);
      expect(d.label, `${type} badge is not keyed`).toMatch(/^«[a-z]/);
    }
  });

  it("renders no English label for a French reader, on any declared type", () => {
    // The assertion that matters: not "a key exists" but "the surface changes
    // language". Compared against the module's OWN English output rather than a
    // hand-copied list, so it cannot go stale.
    //
    // A type is only required to differ where its English and French copy
    // differ — "Rally" is "Rally" in French — so derive the expectation from
    // the dictionaries instead of asserting it blindly.
    let differing = 0;
    for (const type of declaredEventTypes()) {
      const key = EVENT_KEY[type];
      const e = describeEvent(type, sample(type), NAMES, en);
      const f = describeEvent(type, sample(type), NAMES, fr);
      if (key && uiFr[key] !== uiEn[key]) {
        differing += 1;
        expect(f.label, `${type} badge still reads as English`).not.toBe(e.label);
      }
      expect(f.tone, `${type} changed tone with locale`).toBe(e.tone);
    }
    // Guard the loop above against a dictionary where nothing differs.
    expect(differing).toBeGreaterThanOrEqual(30);
  });

  it("localizes the sentences too, not only the badges", () => {
    // Each of these used to be a hardcoded English literal in this module.
    const cases: [string, Record<string, unknown>][] = [
      ["core.void", {}],
      ["core.forfeit", { by: "e1", reason: "weather" }],
      ["core.abandon", { reason: "rain" }],
      ["football.period", { phase: "ET_H1" }],
      ["football.shootout.kick", { by: "p1", scored: false }],
      ["boardgame.result", { winner: "p1", method: "checkmate" }],
      ["generic.result", { isDraw: true }],
      ["badminton.game.summary", { home: 21, away: 19, partial: true }],
      ["volleyball.rally", { wonBy: "e1" }],
    ];
    for (const [type, payload] of cases) {
      const e = describeEvent(type, payload, NAMES, en).text;
      const f = describeEvent(type, payload, NAMES, fr).text;
      expect(e, `${type} rendered no sentence to compare`).not.toBe("");
      expect(f, `${type} sentence still reads as English`).not.toBe(e);
    }
  });

  it("carries no second name for an event type scoring-vocab already owns", () => {
    // The drift guard. Any badge event-copy renders for a keyed type must be
    // BYTE-IDENTICAL to what `eventLabel` would produce, in every locale — the
    // two-sources-of-truth failure this change exists to remove.
    for (const [locale, dict] of Object.entries(LOCALES)) {
      const m = at(locale as keyof typeof LOCALES);
      for (const type of declaredEventTypes()) {
        const key = EVENT_KEY[type];
        if (!key) continue;
        // Payload-specialized badges (a card's colour, a goal's own-goal flag)
        // are allowed to differ — those are read off the PAYLOAD, not a second
        // name for the type — so probe with an empty payload.
        expect(describeEvent(type, {}, NAMES, m).label, `${locale} ${type} badge diverged`)
          .toBe(dict[key]);
      }
    }
  });

  it("ships every key it can emit in ALL FOUR dictionaries", () => {
    for (const [locale, dict] of Object.entries(LOCALES)) {
      for (const key of EVENT_COPY_KEYS) {
        // Dictionaries are FLAT dotted-key JSON — a literal lookup, not a walk.
        expect(dict, `missing ${locale} copy for ${key}`).toHaveProperty(key);
      }
    }
  });

  it("still specializes the badge on what the payload says", () => {
    // An own goal is not a goal and a second yellow is not a card; those read
    // off the payload, so they survive the single-source rule above.
    expect(describeEvent("football.goal", { by: "p1", ownGoal: true }, NAMES, echo).label)
      .toBe("«eventCopy.ownGoal»");
    expect(describeEvent("football.card", { by: "p1", color: "second_yellow" }, NAMES, en).label)
      .toBe("Second yellow");
    expect(describeEvent("football.card", { by: "p1", color: "red" }, NAMES, fr).label)
      .toBe(uiFr["cardColor.red"]);
  });

  it("lets the badge carry core.start rather than repeating it as a sentence", () => {
    // `event.core.start` already reads "Match started" in every locale, so a
    // sentence would say it twice. Pinned because an empty `text` looks like an
    // omission next to every other branch.
    const d = describeEvent("core.start", {}, NAMES, fr);
    expect(d.label).toBe(uiFr["event.core.start"]);
    expect(d.label).not.toBe(uiEn["event.core.start"]);
    expect(d.text).toBe("");
  });

  it("degrades rather than throwing on a type no sport declares", () => {
    const d = describeEvent("kabaddi.raid", { raider: "p1", points: 2 }, NAMES, echo);
    expect(d.label).toBe("Raid");
    expect(d.tone).toBe("note");
  });
});
