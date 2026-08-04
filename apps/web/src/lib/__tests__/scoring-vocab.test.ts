import { describe, it, expect } from "vitest";
import {
  wicketLabel, extraLabel, sportLabel, swatchLabel,
  eventLabel, enumLabel, engineErrorLabel, scoringErrorText, positionLabel,
  EVENT_KEY, ENUM_VOCAB, ENGINE_ERROR_KEY, POSITION_KEY,
  SCORING_VOCAB_KEYS, type MsgFn,
} from "@/lib/scoring-vocab";
import { builtinModules } from "@seazn/engine/sports";
import { EngineErrorCode, matchPositionOf } from "@seazn/engine/core";
import { buildStream, defaultLineupPair } from "@seazn/engine/testkit";
import uiEn from "@/dictionaries/en/ui.json";
import uiEs from "@/dictionaries/es/ui.json";
import uiFr from "@/dictionaries/fr/ui.json";
import uiNl from "@/dictionaries/nl/ui.json";

// Stub translator: echoes the key so we can prove which key each helper looks up.
const echo: MsgFn = (k) => `«${k}»`;
// Real en lookup, to prove keys resolve against the actual dictionary.
const en: MsgFn = (k) => (uiEn as Record<string, string>)[k];

const LOCALES = {
  en: uiEn as Record<string, string>,
  es: uiEs as Record<string, string>,
  fr: uiFr as Record<string, string>,
  nl: uiNl as Record<string, string>,
};

describe("scoring-vocab label helpers", () => {
  it("maps closed-enum values to their key", () => {
    expect(wicketLabel("bowled", echo)).toBe("«wicket.bowled»");
    expect(extraLabel("legbye", echo)).toBe("«extra.legbye»");
    expect(sportLabel("boardgame", echo)).toBe("«sport.boardgame»");
  });

  it("resolves against the real en dictionary", () => {
    expect(sportLabel("boardgame", en)).toBe("Board game");
    expect(wicketLabel("runout", en)).toBe("Run out");
    expect(extraLabel("noball", en)).toBe("No-ball");
  });

  it("falls back to title-case for unknown values (never throws)", () => {
    expect(sportLabel("kabaddi", echo)).toBe("Kabaddi");
    expect(wicketLabel("mankad", echo)).toBe("Mankad");
  });

  it("swatchLabel keys off the palette hex, null-safe", () => {
    expect(swatchLabel("#0f766e", echo)).toBe("«swatch.Teal»");
    expect(swatchLabel("#0f766e", en)).toBe("Teal");
    expect(swatchLabel(null, echo)).toBeNull();
    expect(swatchLabel("#123456", echo)).toBeNull(); // not a palette swatch
  });

  it("every emitted key exists in ALL FOUR dictionaries (exhaustiveness)", () => {
    for (const [locale, dict] of Object.entries(LOCALES)) {
      for (const key of SCORING_VOCAB_KEYS) {
        // Dictionaries are FLAT dotted-key JSON — toHaveProperty checks the
        // literal key before it tries a path walk, so this is a flat lookup.
        expect(dict, `missing ${locale} key ${key}`).toHaveProperty(key);
      }
    }
  });
});

// ── Derived completeness (#427) ───────────────────────────────────────────────
// The expected sets are read from the engine's OWN declarations at test time,
// never hand-copied: a hand-copied list goes stale the moment a wave adds an
// event type, which is precisely the defect #427 exists to close. Add a type or
// an enum member in packages/engine and this suite reds until a label lands in
// all four dictionaries.

/** Every event type any shipped module declares in its fidelity tiers. */
function declaredEventTypes(): string[] {
  const out = new Set<string>();
  for (const m of builtinModules as unknown as EngineModule[]) {
    for (const tier of m.fidelityTiers ?? []) for (const t of tier.eventTypes) out.add(t);
  }
  return [...out].sort();
}

interface EngineModule {
  key: string;
  fidelityTiers?: readonly { eventTypes: readonly string[] }[];
  eventSchema?: unknown;
}

/**
 * Walk a module's zod payload union and collect every enum's options, keyed by
 * the FIELD the enum sits on. Payload schemas carry no type discriminator (the
 * event type lives on the envelope), so the field name is the only stable
 * handle — and it is the right one: `kind.other` and `reason.other` are
 * different vocabulary, `color.red` is the same word wherever it appears.
 */
function walkEnums(
  schema: unknown, field: string, out: Map<string, Set<string>>, seen: Set<unknown>, depth = 0,
): void {
  if (!schema || typeof schema !== "object" || depth > 12 || seen.has(schema)) return;
  seen.add(schema);
  const s = schema as Record<string, unknown>;
  const def = (s._def ?? {}) as Record<string, unknown>;
  const kind = (def.type ?? def.typeName) as string | undefined;
  if (kind === "enum" || kind === "ZodEnum") {
    const opts = def.entries
      ? Object.keys(def.entries as object)
      : ((s.options ?? def.values ?? []) as string[]);
    if (!out.has(field)) out.set(field, new Set());
    for (const o of opts) out.get(field)!.add(String(o));
    return;
  }
  if (kind === "literal" || kind === "ZodLiteral") return;
  const shape = (typeof s.shape === "object" && s.shape) ||
    (typeof def.shape === "function" ? (def.shape as () => object)() : def.shape);
  if (shape && typeof shape === "object") {
    for (const [k, v] of Object.entries(shape)) walkEnums(v, k, out, seen, depth + 1);
    return;
  }
  for (const k of ["options", "innerType", "element", "valueType", "left", "right", "in", "out"]) {
    const v = def[k] ?? s[k];
    if (Array.isArray(v)) v.forEach((x) => walkEnums(x, field, out, seen, depth + 1));
    else if (v) walkEnums(v, field, out, seen, depth + 1);
  }
}

/** field name → every enum member the engine can put in it, across all sports. */
function declaredEnumMembers(): Map<string, Set<string>> {
  const all = new Map<string, Set<string>>();
  for (const m of builtinModules as unknown as EngineModule[]) {
    const out = new Map<string, Set<string>>();
    walkEnums(m.eventSchema, "<root>", out, new Set());
    for (const [f, members] of out) {
      if (!all.has(f)) all.set(f, new Set());
      for (const x of members) all.get(f)!.add(x);
    }
  }
  return all;
}

interface DrivableModule {
  key: string;
  positions: unknown;
  configSchema: { parse(value: unknown): unknown };
  init(cfg: unknown, lineups: unknown): unknown;
  apply(state: unknown, envelope: unknown): unknown;
  position?: (state: unknown) => unknown;
}

/**
 * Every position-segment key the projecting sports actually emit (W4a's
 * cross-sport match-position axis, `@seazn/engine/core` position.ts).
 *
 * Folded out of real generated streams, because there is nothing static to
 * read: a module builds its segments INSIDE `position(state)`, and which keys
 * appear depends on the state — a set-based sport only emits `points` while a
 * set is live, a period sport only emits `clock` once a stamp names the phase
 * it resolved to. A hand-copied list is the exact defect this file exists to
 * close, and it already bit once here: the wave's own summary named five keys
 * (`set`, `game`, `innings`, `over`, `board`) and missed three.
 */
function declaredPositionKeys(): { keys: Set<string>; projecting: number } {
  const keys = new Set<string>();
  let projecting = 0;
  for (const sport of builtinModules as unknown as DrivableModule[]) {
    if (sport.position === undefined) continue;
    projecting += 1;
    const cfg = sport.configSchema.parse({});
    const lineups = defaultLineupPair(sport.positions as never);
    for (const seed of [1, 7, 42]) {
      let state: unknown = sport.init(cfg, lineups);
      const collect = () => {
        const position = matchPositionOf(sport as never, state);
        for (const segment of position?.segments ?? []) keys.add(segment.key);
      };
      collect();
      for (const envelope of buildStream(sport as never, cfg as never, lineups, seed, 300)) {
        state = sport.apply(state, envelope);
        collect();
      }
    }
  }
  return { keys, projecting };
}

describe("scoring-vocab covers what the engine declares", () => {
  // Vacuity guards. A derivation that silently returns nothing — a zod internals
  // change, a renamed field — would make every assertion below pass while
  // proving nothing, so pin the shape of the derived sets first.
  it("the derivation actually reaches the engine's declarations", () => {
    const types = declaredEventTypes();
    expect(types.length).toBeGreaterThanOrEqual(55);
    expect(types).toContain("tabletennis.expedite.start");
    expect(types).toContain("tennis.interruption");
    expect(types).toContain("football.sinbin.start");
    expect(types).toContain("hockey.suspension.end");

    const enums = declaredEnumMembers();
    expect([...enums.keys()].sort()).toEqual(
      ["color", "elected", "kind", "level", "method", "outcome", "phase", "reason", "receiverSide"],
    );
    // W4a's own additions, one per sport that grew an enum.
    expect([...(enums.get("method") ?? [])]).toEqual(
      expect.arrayContaining(["repetition", "fifty_move", "dead_position", "illegal_move"]),
    );
    expect([...(enums.get("kind") ?? [])]).toEqual(
      expect.arrayContaining(["medical", "toilet", "heat", "other"]),
    );
    expect([...enums.values()].reduce((n, s) => n + s.size, 0)).toBeGreaterThanOrEqual(85);

    expect(EngineErrorCode.options.length).toBeGreaterThanOrEqual(17);
    expect(EngineErrorCode.options).toEqual(
      expect.arrayContaining([
        "NON_MONOTONIC_TIME", "UNKNOWN_PHASE", "EXPEDITE_WRONG_WINNER", "SUB_WINDOW_EXCEEDED",
      ]),
    );
  });

  it("the position derivation reaches every projecting sport", () => {
    // Vacuity guard. A fold that produced nothing — a renamed member, a stream
    // generator that stops at seq 0 — would make the coverage loop below pass
    // over an empty set. Pin the shape, and pin by name the three keys the
    // wave's hand-written summary of this axis left out.
    const { keys, projecting } = declaredPositionKeys();
    expect(projecting).toBe(9); // boardgame and generic honestly abstain
    expect(keys.size).toBeGreaterThanOrEqual(8);
    for (const key of ["set", "game", "innings", "over", "board", "points", "period", "clock"]) {
      expect(keys, `stream fold never emitted position key "${key}"`).toContain(key);
    }
  });

  it("labels every position segment key the engine emits", () => {
    for (const key of declaredPositionKeys().keys) {
      expect(POSITION_KEY, `no label for position segment key "${key}"`).toHaveProperty([key]);
    }
  });

  it("resolves position copy against the real en dictionary, and falls back", () => {
    expect(positionLabel("over", en)).toBe("Over");
    expect(positionLabel("clock", en)).toBe("Clock");
    expect(positionLabel("board", echo)).toBe("«scoring.position.board»");
    // Unknown key: the engine's own English label wins over a humanized token.
    expect(positionLabel("frame", echo, "Frame")).toBe("Frame");
    expect(positionLabel("half_inning", echo)).toBe("Half inning");
  });

  it("exports the vocabulary maps the coverage assertions read", () => {
    // Vite resolves a missing named export to `undefined`, so a coverage loop
    // over an absent map is vacuously green. Prove the maps exist first.
    expect(EVENT_KEY).toBeTypeOf("object");
    expect(ENUM_VOCAB).toBeTypeOf("object");
    expect(ENGINE_ERROR_KEY).toBeTypeOf("object");
    expect(POSITION_KEY).toBeTypeOf("object");
    expect(positionLabel).toBeTypeOf("function");
    expect(eventLabel).toBeTypeOf("function");
    expect(enumLabel).toBeTypeOf("function");
    expect(engineErrorLabel).toBeTypeOf("function");
  });

  it("labels every event type the engine declares", () => {
    for (const type of declaredEventTypes()) {
      expect(EVENT_KEY, `no label for event type ${type}`).toHaveProperty([type]);
    }
  });

  it("labels every enum member the engine declares", () => {
    for (const [field, members] of declaredEnumMembers()) {
      const maps = ENUM_VOCAB[field];
      expect(maps, `no vocabulary bound for enum field "${field}"`).toBeDefined();
      for (const member of members) {
        const covered = maps.some((m) => Object.prototype.hasOwnProperty.call(m, member));
        expect(covered, `no label for ${field} member "${member}"`).toBe(true);
      }
    }
  });

  it("labels every engine error code (they reach the scorer's screen)", () => {
    for (const code of EngineErrorCode.options) {
      expect(ENGINE_ERROR_KEY, `no copy for EngineErrorCode ${code}`).toHaveProperty([code]);
    }
  });

  it("resolves the new W4a vocabulary against the real en dictionary", () => {
    expect(eventLabel("tabletennis.expedite.start", en)).toBe("Expedite system");
    expect(eventLabel("tennis.interruption", en)).toBe("Interruption");
    expect(enumLabel("method", "fifty_move", en)).toBe("Fifty-move rule");
    expect(enumLabel("kind", "toilet", en)).toBe("Toilet break");
    expect(engineErrorLabel("EXPEDITE_WRONG_WINNER", en)).toBe(
      "Under the expedite system the receiver wins that rally. Check who won it.",
    );
  });

  it("falls back rather than throwing on vocabulary it does not know", () => {
    expect(eventLabel("kabaddi.raid", echo)).toBe("Raid");
    expect(enumLabel("kind", "mankad", echo)).toBe("Mankad");
    expect(enumLabel("nosuchfield", "x", echo)).toBe("X");
  });
});

describe("scoringErrorText keeps engine English off the scorer's screen", () => {
  // The pads used to do `setError(err.message)`, which rendered the engine's
  // own English EngineError.message verbatim in every locale — the API
  // serialises it into the error envelope and ApiV1Error carries it through.
  const fr: MsgFn = (k) => (uiFr as Record<string, string>)[k];

  it("prefers localized copy for an engine code over the raw English message", () => {
    expect(
      scoringErrorText("EXPEDITE_WRONG_WINNER", "expedite: receiver wins", fr, "device.failed"),
    ).toBe(uiFr["engineError.EXPEDITE_WRONG_WINNER"]);
    expect(
      scoringErrorText("SUB_WINDOW_EXCEEDED", "sub window exceeded", fr, "device.failed"),
    ).toBe(uiFr["engineError.SUB_WINDOW_EXCEEDED"]);
    expect(scoringErrorText("NON_MONOTONIC_TIME", "at precedes high-water mark", fr, "device.failed"))
      .not.toContain("high-water");
  });

  it("keeps the raw message for a non-engine failure, and the fallback for none", () => {
    expect(scoringErrorText("RATE_LIMITED", "Slow down", fr, "device.failed")).toBe("Slow down");
    expect(scoringErrorText(null, null, fr, "device.failed")).toBe(uiFr["device.failed"]);
    expect(scoringErrorText("UNKNOWN", "", fr, "device.failed")).toBe(uiFr["device.failed"]);
  });
});
