import { describe, it, expect } from "vitest";
import {
  wicketLabel, extraLabel, sportLabel, swatchLabel,
  SCORING_VOCAB_KEYS, type MsgFn,
} from "@/lib/scoring-vocab";
import uiEn from "@/dictionaries/en/ui.json";

// Stub translator: echoes the key so we can prove which key each helper looks up.
const echo: MsgFn = (k) => `«${k}»`;
// Real en lookup, to prove keys resolve against the actual dictionary.
const en: MsgFn = (k) => (uiEn as Record<string, string>)[k];

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

  it("every emitted key exists in the en dictionary (exhaustiveness)", () => {
    for (const key of SCORING_VOCAB_KEYS) {
      expect(uiEn, `missing en key ${key}`).toHaveProperty(key);
    }
  });
});
