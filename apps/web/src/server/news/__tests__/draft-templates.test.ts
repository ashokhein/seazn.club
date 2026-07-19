// PROMPT-82 Step 2 — pure draft templates (no DB). Title exactness, body
// composition (competition line, venue-tz date, conditional scorers/movement),
// round recap results + standings, and locale switching of static strings.
import { describe, expect, it } from "vitest";
import { resultDraft, roundRecapDraft, draftWhen } from "../draft-templates";

const BASE = {
  locale: "en" as const,
  homeName: "Riverside",
  awayName: "Northside",
  homeScore: "3",
  awayScore: "1",
  competitionName: "Spring Cup",
  divisionName: "Premier",
  // A fixed instant that lands in the afternoon in Europe/London.
  scheduledAt: "2026-05-10T13:30:00.000Z",
  venueTz: "Europe/London",
  venue: "Riverside Park",
};

describe("resultDraft", () => {
  it("title is exactly '{home} {s}–{s} {away}' with an en dash", () => {
    const { title } = resultDraft(BASE);
    expect(title).toBe("Riverside 3–1 Northside");
  });

  it("body carries the competition line and a venue-tz date", () => {
    const { bodyMd } = resultDraft(BASE);
    expect(bodyMd).toContain("Spring Cup");
    expect(bodyMd).toContain("Premier");
    expect(bodyMd).toContain("Riverside Park");
    // venue zone is labelled and rendered in-zone (14:30 BST, not 13:30 UTC).
    expect(bodyMd).toContain("(Europe/London)");
    expect(bodyMd).toContain("14:30");
  });

  it("scorers block appears only when provided", () => {
    expect(resultDraft(BASE).bodyMd).not.toContain("Scorers");
    const withScorers = resultDraft({
      ...BASE,
      scorers: [{ name: "A. Smith", count: 2 }, { name: "B. Jones" }],
    });
    expect(withScorers.bodyMd).toContain("Scorers");
    expect(withScorers.bodyMd).toContain("A. Smith (2)");
    expect(withScorers.bodyMd).toContain("- B. Jones");
    expect(withScorers.bodyMd).not.toContain("B. Jones (");
  });

  it("standings-movement line appears only when provided", () => {
    expect(resultDraft(BASE).bodyMd).not.toContain("moves up");
    const moved = resultDraft({ ...BASE, movement: { team: "Riverside", position: 2 } });
    expect(moved.bodyMd).toContain("Riverside moves up to 2nd.");
  });

  it("locale switches the static strings (fr/es/nl)", () => {
    const scorers = [{ name: "A. Smith" }];
    const movement = { team: "Riverside", position: 2 };
    expect(resultDraft({ ...BASE, locale: "fr", scorers, movement }).bodyMd).toContain("Buteurs");
    expect(resultDraft({ ...BASE, locale: "fr", scorers, movement }).bodyMd).toContain("2e place");
    expect(resultDraft({ ...BASE, locale: "es", scorers }).bodyMd).toContain("Goleadores");
    expect(resultDraft({ ...BASE, locale: "nl", scorers }).bodyMd).toContain("Doelpuntenmakers");
  });

  it("fr locale renders fully localized strings with no unresolved tokens", () => {
    const { bodyMd } = resultDraft({
      ...BASE,
      locale: "fr",
      scheduledAt: null,
      venueTz: null,
      scorers: [{ name: "A. Smith", count: 2 }],
      movement: { team: "Riverside", position: 2 },
    });
    expect(bodyMd).not.toContain("undefined");
    expect(bodyMd).not.toContain("null");
    expect(bodyMd).not.toContain("{{");
    // English fallbacks must not leak through when the locale is fr.
    expect(bodyMd).not.toContain("Scorers");
    expect(bodyMd).not.toContain("moves up");
    expect(bodyMd).toContain("Buteurs");
    expect(bodyMd).toContain("A. Smith (2)");
    expect(bodyMd).toContain("Riverside monte à la 2e place.");
    expect(bodyMd).toContain("À confirmer"); // localized TBC placeholder (no scheduledAt)
  });
});

describe("roundRecapDraft", () => {
  const input = {
    locale: "en" as const,
    competitionName: "Spring Cup",
    divisionName: "Premier",
    roundNo: 3,
    results: [
      { homeName: "Riverside", homeScore: "3", awayName: "Northside", awayScore: "1" },
      { homeName: "Eastend", homeScore: "0", awayName: "Westgate", awayScore: "0" },
    ],
    standings: [
      { position: 1, name: "Riverside", played: 3, points: 9 },
      { position: 2, name: "Westgate", played: 3, points: 5 },
      { position: 3, name: "Eastend", played: 3, points: 4 },
    ],
  };

  it("title uses the 1-based round number and the division", () => {
    expect(roundRecapDraft(input).title).toBe("Round 3 recap: Premier");
  });

  it("body contains every result line and the top-3 standings block", () => {
    const { bodyMd } = roundRecapDraft(input);
    expect(bodyMd).toContain("Riverside 3–1 Northside");
    expect(bodyMd).toContain("Eastend 0–0 Westgate");
    expect(bodyMd).toContain("Standings");
    expect(bodyMd).toContain("1. Riverside — 9 pts (3)");
    expect(bodyMd).toContain("2. Westgate — 5 pts (3)");
    expect(bodyMd).toContain("3. Eastend — 4 pts (3)");
  });

  it("clamps the standings block to exactly the given rows when fewer than 5 entrants exist — no padding/undefined", () => {
    const twoTeamInput = {
      ...input,
      standings: [
        { position: 1, name: "Riverside", played: 3, points: 9 },
        { position: 2, name: "Northside", played: 3, points: 6 },
      ],
    };
    const { bodyMd } = roundRecapDraft(twoTeamInput);
    expect(bodyMd).not.toContain("undefined");
    expect(bodyMd).not.toContain("null");
    // Exactly two standings lines — no padding to a fixed 5-row block.
    const standingsLines = bodyMd
      .split("\n")
      .filter((l) => /^\d+\. /.test(l));
    expect(standingsLines).toHaveLength(2);
    expect(bodyMd).toContain("1. Riverside — 9 pts (3)");
    expect(bodyMd).toContain("2. Northside — 6 pts (3)");
    expect(bodyMd).not.toContain("3. ");
  });

  it("localizes the section headings", () => {
    const fr = roundRecapDraft({ ...input, locale: "fr" });
    expect(fr.bodyMd).toContain("Résultats");
    expect(fr.bodyMd).toContain("Classement");
    expect(fr.title).toContain("journée 3");
  });
});

describe("draftWhen", () => {
  it("returns the locale's TBC placeholder when unscheduled", () => {
    expect(draftWhen(null, "Europe/London", "en")).toBe("TBC");
    expect(draftWhen(null, null, "es")).toBe("Por confirmar");
  });
});
