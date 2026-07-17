// Unit tests for the CSV header auto-mapper (Jul3/01 §3/§8). Pure, no DB.
// Regression for the design/fix-ui/05 "column auto-mapper silently drops
// columns" bug: HEADER_ALIASES only had English words, so a French (or
// Spanish/Dutch) header row — including accented letters like "Équipe" and
// "Numéro" — matched at most 2 of the page's own documented 8 columns.
import { describe, expect, it } from "vitest";
import { detectMapping, normalizeHeader } from "../import-parse";

describe("normalizeHeader", () => {
  it("strips diacritics before folding to [a-z0-9]", () => {
    expect(normalizeHeader("Équipe")).toBe("equipe");
    expect(normalizeHeader("Numéro")).toBe("numero");
    expect(normalizeHeader("División")).toBe("division");
    expect(normalizeHeader("Posición")).toBe("posicion");
  });
});

describe("detectMapping — locale header coverage (Jul3/01 §8)", () => {
  // The exact header lists promised in import.fileHint for each shipped
  // locale (src/dictionaries/<locale>/ui.json) — every one of these columns
  // must auto-map, not just the ones that happen to spell the same in English.
  const CASES: [string, string[]][] = [
    ["en", ["Club", "Team", "Player", "DOB", "Number", "Position", "Captain", "Division"]],
    ["fr", ["Club", "Équipe", "Joueur", "Date de naissance", "Numéro", "Poste", "Capitaine", "Division"]],
    ["es", ["Club", "Equipo", "Jugador", "Fecha de nacimiento", "Número", "Posición", "Capitán", "División"]],
    ["nl", ["Club", "Team", "Speler", "Geboortedatum", "Nummer", "Positie", "Aanvoerder", "Divisie"]],
  ];

  for (const [locale, headers] of CASES) {
    it(`maps all ${headers.length} documented ${locale} headers`, () => {
      const mapping = detectMapping(headers);
      expect(Object.keys(mapping)).toHaveLength(headers.length);
    });
  }

  it("fr headers map to the right fields (the reported repro case)", () => {
    const headers = ["Club", "Équipe", "Joueur", "Division"];
    const mapping = detectMapping(headers);
    expect(mapping).toEqual({
      Club: "clubName",
      Équipe: "teamName",
      Joueur: "playerFullName",
      Division: "divisionSlug",
    });
  });
});
