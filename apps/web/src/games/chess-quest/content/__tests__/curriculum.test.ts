import { describe, expect, it } from "vitest";
import { parseFEN } from "../../engine";
import { LANDS } from "../lands";
import { LESSONS } from "../lessons";
import { TACTICS, TACTICS2 } from "../puzzles";

const GAME_IDS = [
  "squareRace",
  "coinHop",
  "pawnWars",
  "mateInOne",
  "mateInTwo",
  "hangingHunt",
  "tacticTrainer",
  "rookMaze",
];

describe("curriculum shape", () => {
  it("48 lessons, numbered 1..48 in order", () => {
    expect(LESSONS).toHaveLength(48);
    LESSONS.forEach((l, i) => expect(l.n).toBe(i + 1));
  });
  it("9 lands tiling lessons 1..48 exactly once", () => {
    expect(LANDS).toHaveLength(9);
    const seen = new Array(49).fill(0);
    for (const land of LANDS) {
      for (let i = land.weeks[0]; i <= land.weeks[1]; i++) seen[i]++;
    }
    expect(seen.slice(1).every((c) => c === 1)).toBe(true);
  });
  it("every lesson's land id matches the land covering its number", () => {
    for (const l of LESSONS) {
      const land = LANDS.find((x) => l.n >= x.weeks[0] && l.n <= x.weeks[1]);
      expect(land?.id, `lesson ${l.n}`).toBe(l.land);
    }
  });
  it("track 2 lands cover lessons 25..48 only", () => {
    for (const land of LANDS.filter((l) => l.track === 2)) {
      expect(land.weeks[0]).toBeGreaterThanOrEqual(25);
    }
  });
  it("every land has both check registers", () => {
    for (const land of LANDS) {
      expect(land.check.length).toBeGreaterThan(0);
      expect(land.checkClassic.length).toBeGreaterThan(0);
    }
  });
  it("every lesson has story + classic copy", () => {
    for (const l of LESSONS) {
      expect(l.learn.length).toBeGreaterThan(0);
      expect(l.play.length).toBeGreaterThan(0);
      expect(l.spark.length).toBeGreaterThan(0);
      expect(l.classic.learn.length).toBeGreaterThan(0);
      expect(l.classic.play.length).toBeGreaterThan(0);
      expect(l.classic.spark.length).toBeGreaterThan(0);
    }
  });
  it("every game id is real", () => {
    for (const l of LESSONS) {
      if (l.game !== null) expect(GAME_IDS).toContain(l.game);
    }
  });
  it("all diagram FENs parse to 64 squares", () => {
    for (const l of LESSONS) {
      if (!l.diagram) continue;
      expect(parseFEN(l.diagram.fen).board, `lesson ${l.n}`).toHaveLength(64);
    }
  });
  it("tactic-trainer lessons point at existing packs", () => {
    for (const l of LESSONS.filter((x) => x.game === "tacticTrainer")) {
      const pack = l.gameOpts?.pack ?? "";
      const exists = pack in TACTICS || pack in TACTICS2;
      expect(exists, `lesson ${l.n} pack "${pack}"`).toBe(true);
    }
  });
});
