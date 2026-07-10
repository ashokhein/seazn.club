// Registration reference numbers (v3/05 §3, PROMPT-34): human-quotable,
// crockford-style alphabet with no look-alikes, self-checking, retryable.
import { describe, expect, it } from "vitest";
import {
  REF_ALPHABET,
  formatRefCode,
  generateRefCode,
  isValidRefCode,
  normalizeRefCode,
} from "@/lib/ref-code";

describe("REF_ALPHABET", () => {
  it("excludes the look-alike characters 0/O/1/I (and crockford's L/U)", () => {
    for (const ch of ["0", "O", "1", "I", "L", "U"]) {
      expect(REF_ALPHABET).not.toContain(ch);
    }
  });

  it("is uppercase and free of duplicates", () => {
    expect(REF_ALPHABET).toBe(REF_ALPHABET.toUpperCase());
    expect(new Set(REF_ALPHABET.split("")).size).toBe(REF_ALPHABET.length);
  });
});

describe("generateRefCode", () => {
  it("produces SZ-XXXX-XXXX with only alphabet characters", () => {
    for (let i = 0; i < 50; i++) {
      const code = generateRefCode();
      expect(code).toMatch(/^SZ-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      for (const ch of code.replace(/^SZ-/, "").replace(/-/g, "")) {
        expect(REF_ALPHABET).toContain(ch);
      }
    }
  });

  it("embeds a checksum that validates", () => {
    for (let i = 0; i < 50; i++) {
      expect(isValidRefCode(generateRefCode())).toBe(true);
    }
  });

  it("draws fresh randomness each call (collision retry is meaningful)", () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateRefCode()));
    expect(seen.size).toBe(200);
  });
});

describe("isValidRefCode", () => {
  it("rejects a single flipped character (checksum catches typos)", () => {
    const code = generateRefCode();
    const chars = code.replace("SZ-", "").replace(/-/g, "").split("");
    // flip one payload character to a different alphabet character
    const idx = 2;
    const flip = REF_ALPHABET[(REF_ALPHABET.indexOf(chars[idx]!) + 1) % REF_ALPHABET.length]!;
    chars[idx] = flip;
    expect(isValidRefCode(formatRefCode(chars.join("")))).toBe(false);
  });

  it("rejects garbage and wrong shapes", () => {
    expect(isValidRefCode("")).toBe(false);
    expect(isValidRefCode("SZ-0000-0000")).toBe(false); // excluded chars
    expect(isValidRefCode("XX-ABCD-EFGH")).toBe(false); // wrong prefix
    expect(isValidRefCode("SZ-ABC-DEFGH")).toBe(false); // wrong grouping
  });
});

describe("normalizeRefCode", () => {
  it("uppercases, trims and restores dashes from quoted forms", () => {
    const code = generateRefCode();
    const raw = code.toLowerCase().replace(/-/g, "");
    expect(normalizeRefCode(` ${raw} `)).toBe(code);
    expect(normalizeRefCode(code.toLowerCase())).toBe(code);
  });
});
