// Pure helpers for the public dashboard (PROMPT-12).
import { describe, expect, it } from "vitest";
import {
  isReservedSlug,
  buildIcs,
  sportsEventJsonLd,
  standingsColumns,
  formatMetric,
  setBreakdown,
  stripLiveSetPoints,
  type StandingsRowLike,
} from "@/lib/public-site";

describe("reserved slugs (doc 09 §1)", () => {
  it("blocks every existing top-level app route", () => {
    for (const slug of ["api", "admin", "dashboard", "login", "tournaments", "t", "legal"]) {
      expect(isReservedSlug(slug)).toBe(true);
    }
  });
  it("is case-insensitive and allows normal org slugs", () => {
    expect(isReservedSlug("API")).toBe(true);
    expect(isReservedSlug("riverside-cc")).toBe(false);
  });
});

describe("ICS feed (doc 09 §2)", () => {
  const event = {
    uid: "fx-1",
    start: new Date("2026-07-12T14:00:00Z"),
    durationMinutes: 90,
    summary: "Tigers vs Lions; Semi, final",
    location: "Main Hall",
  };

  it("emits a valid VCALENDAR with escaped TEXT and DTEND from duration", () => {
    const ics = buildIcs("U16 T20", [event]);
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("DTSTART:20260712T140000Z");
    expect(ics).toContain("DTEND:20260712T153000Z");
    expect(ics).toContain("SUMMARY:Tigers vs Lions\\; Semi\\, final");
    expect(ics).toContain("UID:fx-1@seazn.club");
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
  });

  it("folds lines longer than 75 octets with a leading space", () => {
    const long = buildIcs("Cal", [
      { ...event, summary: "A".repeat(120) },
    ]);
    const folded = long.split("\r\n").find((l) => l.startsWith(" "));
    expect(folded).toBeDefined();
    expect(long.split("\r\n").every((l) => l.length <= 74)).toBe(true);
  });
});

describe("SportsEvent JSON-LD (doc 09 §3)", () => {
  it("escapes < so the payload cannot close its script tag", () => {
    const json = sportsEventJsonLd({
      name: "Tigers </script><script> vs Lions",
      url: "https://seazn.club/x/y",
      eventStatus: "EventScheduled",
    });
    expect(json).not.toContain("</script>");
    expect(JSON.parse(json)["@type"]).toBe("SportsEvent");
  });
});

describe("standings columns — MetricSpec-driven (doc 09 §2)", () => {
  const specs = [
    { key: "gf", label: "GF" },
    { key: "ga", label: "GA" },
    { key: "gd", label: "GD" },
    { key: "yellow", label: "Yellow cards", display: false },
  ];
  const derived = [{ key: "nrr", label: "NRR", decimals: 3 }];
  const row = (over: Partial<StandingsRowLike>): StandingsRowLike => ({
    entrantId: "A",
    played: 3,
    won: 2,
    drawn: 0,
    lost: 1,
    points: 6,
    metrics: { gf: 5, ga: 2, gd: 3, yellow: 1 },
    ...over,
  });

  it("football shape: P W L + GF GA GD + Pts, no display:false columns", () => {
    const cols = standingsColumns(specs, ["points", "diff"], [row({})], derived);
    expect(cols.map((c) => c.key)).toEqual(["played", "won", "lost", "gf", "ga", "gd", "points"]);
  });

  it("adds a D column as soon as any row has a draw", () => {
    const cols = standingsColumns(specs, ["points"], [row({ drawn: 1 })], derived);
    expect(cols.map((c) => c.key)).toContain("drawn");
  });

  it("adds a derived column only when the cascade uses it", () => {
    const withNrr = standingsColumns(specs, ["points", "nrr"], [row({})], derived);
    expect(withNrr.map((c) => c.key)).toContain("nrr");
    const without = standingsColumns(specs, ["points"], [row({})], derived);
    expect(without.map((c) => c.key)).not.toContain("nrr");
  });

  it("hides a metric column no row carries", () => {
    const cols = standingsColumns(
      [...specs, { key: "buchholz", label: "Buchholz" }],
      ["points"],
      [row({})],
      derived,
    );
    expect(cols.map((c) => c.key)).not.toContain("buchholz");
  });
});

describe("formatMetric", () => {
  it("renders dashes, integers and fixed decimals", () => {
    expect(formatMetric(undefined)).toBe("—");
    expect(formatMetric(3)).toBe("3");
    expect(formatMetric(1.5, 2)).toBe("1.50");
  });
});

describe("setBreakdown (public per-set scoreboard)", () => {
  const summary = {
    headline: "1 — 0 (5–3)",
    perSide: [
      { entrantId: "H", line: "1" },
      { entrantId: "A", line: "0" },
    ],
    detail: {
      sets: [
        { home: 21, away: 15, closed: true },
        { home: 5, away: 3, closed: false },
      ],
      points: { home: 26, away: 18 },
    },
  };

  it("extracts every set including the live one, unit-labelled per sport", () => {
    expect(setBreakdown(summary, "badminton")).toEqual({
      unit: "Game",
      sets: [
        { home: 21, away: 15, closed: true },
        { home: 5, away: 3, closed: false },
      ],
    });
    expect(setBreakdown(summary, "tabletennis")?.unit).toBe("Game");
    expect(setBreakdown(summary, "volleyball")?.unit).toBe("Set");
  });

  it("returns null for non-set-based or malformed summaries", () => {
    expect(setBreakdown(null, "badminton")).toBeNull();
    expect(setBreakdown({ headline: "2 — 1" }, "football")).toBeNull();
    expect(setBreakdown({ detail: { sets: [] } }, "badminton")).toBeNull();
    // cricket-style detail with a different shape must not leak through
    expect(setBreakdown({ detail: { innings: [{ runs: 120 }] } }, "cricket")).toBeNull();
    expect(setBreakdown({ detail: { sets: [{ home: "21", away: 15 }] } }, "badminton")).toBeNull();
  });

  it("strips the live-points suffix from the headline (shown in the card instead)", () => {
    expect(stripLiveSetPoints("1 — 0 (14–11)")).toBe("1 — 0");
    expect(stripLiveSetPoints("2 — 1")).toBe("2 — 1");
  });
});

describe("isoDateTime (timestamptz rows crossing into client components)", () => {
  it("converts Date to ISO string — postgres.js returns Date, client sorts strings", async () => {
    const { isoDateTime } = await import("../public-site");
    const d = new Date("2026-07-11T10:00:00Z");
    expect(isoDateTime(d)).toBe("2026-07-11T10:00:00.000Z");
  });
  it("passes strings through and nulls everything else", async () => {
    const { isoDateTime } = await import("../public-site");
    expect(isoDateTime("2026-07-11T10:00:00Z")).toBe("2026-07-11T10:00:00Z");
    expect(isoDateTime(null)).toBeNull();
    expect(isoDateTime(undefined)).toBeNull();
    expect(isoDateTime(42)).toBeNull();
  });
});

describe("competitionChip (spectator status vocabulary)", () => {
  it("maps completed and archived to finished — completed used to read as upcoming", async () => {
    const { competitionChip } = await import("../public-site");
    expect(competitionChip("completed")).toBe("finished");
    expect(competitionChip("archived")).toBe("finished");
    expect(competitionChip("live")).toBe("on-now");
    expect(competitionChip("draft")).toBe("upcoming");
    expect(competitionChip("published")).toBe("upcoming");
  });
});
