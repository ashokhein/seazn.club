// OG card models (v3/10 #1): youth divisions never print player names
// (v3/11 gap 8) and a failing org accent falls back to platform violet
// (gap 7) — the two rules that MUST hold on platform-cached share images.
import { describe, expect, it } from "vitest";
import { fixtureCardModel, ogTheme, standingsCardModel } from "@/server/og/model";

const brandingOf = (hex: string) => ({ colors: { primary: hex } });

describe("ogTheme contrast guard", () => {
  it("uses a passing brand color", () => {
    const t = ogTheme(brandingOf("#0f766e"));
    expect(t.accent).toBe("#0f766e");
  });

  it("falls back to violet for a low-contrast accent (near-white)", () => {
    const t = ogTheme(brandingOf("#f3f0ff"));
    expect(t.accent).toBe("#7c3aed");
  });

  it("competition branding wins over org branding; empty blobs skip", () => {
    const t = ogTheme(brandingOf("#0f766e"), brandingOf("#1d4ed8"));
    expect(t.accent).toBe("#0f766e");
    const t2 = ogTheme({}, brandingOf("#1d4ed8"));
    expect(t2.accent).toBe("#1d4ed8");
  });
});

const baseStandings = {
  orgName: "Riverside",
  competitionName: "Summer",
  divisionName: "U14 Singles",
  logo: null,
  branding: [],
  rows: [
    { rank: 1, entrantId: "e1", played: 3, points: 9 },
    { rank: 2, entrantId: "e2", played: 3, points: 6 },
  ],
  names: { e1: "Maya Kapoor", e2: "Leo Ng" },
};

describe("standingsCardModel youth rule", () => {
  it("youth + individuals → no names at all, just the fallback line", () => {
    const m = standingsCardModel({ ...baseStandings, youth: true, entrantKind: "individual" });
    expect(m.rows).toHaveLength(0);
    expect(m.fallbackLine).toBeTruthy();
    expect(JSON.stringify(m)).not.toContain("Maya");
    expect(JSON.stringify(m)).not.toContain("Leo");
  });

  it("youth + teams → team names are fine", () => {
    const m = standingsCardModel({
      ...baseStandings,
      names: { e1: "Rockets", e2: "Comets" },
      youth: true,
      entrantKind: "team",
    });
    expect(m.rows.map((r) => r.name)).toEqual(["Rockets", "Comets"]);
  });

  it("adult division → names render, top 6, rank order", () => {
    const m = standingsCardModel({ ...baseStandings, youth: false, entrantKind: "individual" });
    expect(m.rows[0]).toMatchObject({ rank: 1, name: "Maya Kapoor", points: 9 });
    expect(m.fallbackLine).toBeNull();
  });
});

describe("fixtureCardModel youth rule", () => {
  const base = {
    orgName: "Riverside",
    competitionName: "Summer",
    divisionName: "U14 Singles",
    logo: null,
    branding: [],
    homeName: "Maya Kapoor",
    awayName: "Leo Ng",
    headline: "21 – 18",
    fixtureStatus: "decided",
  };

  it("youth individuals: matchup collapses to the division, headline dropped", () => {
    const m = fixtureCardModel({ ...base, youth: true, entrantKind: "individual" });
    expect(JSON.stringify(m)).not.toContain("Maya");
    expect(m.home).toBe("U14 Singles");
    expect(m.headline).toBeNull();
  });

  it("adult: names + headline + result status", () => {
    const m = fixtureCardModel({ ...base, youth: false, entrantKind: "individual" });
    expect(m.home).toBe("Maya Kapoor");
    expect(m.headline).toBe("21 – 18");
    expect(m.status).toBe("result");
  });

  it("in_play maps to live", () => {
    const m = fixtureCardModel({
      ...base, youth: false, entrantKind: "team", fixtureStatus: "in_play",
    });
    expect(m.status).toBe("live");
  });
});
