import { describe, expect, it } from "vitest";
import { STAR_RULES } from "../stars";

describe("star formulas (ported thresholds)", () => {
  it("squareRace", () => {
    expect(STAR_RULES.squareRace(12)).toBe(3);
    expect(STAR_RULES.squareRace(11)).toBe(2);
    expect(STAR_RULES.squareRace(7)).toBe(2);
    expect(STAR_RULES.squareRace(6)).toBe(1);
    expect(STAR_RULES.squareRace(3)).toBe(1);
    expect(STAR_RULES.squareRace(2)).toBe(0);
  });
  it("coinHop — easy sliders vs hard steppers", () => {
    expect(STAR_RULES.coinHop(9, "Q")).toBe(3);
    expect(STAR_RULES.coinHop(10, "Q")).toBe(2);
    expect(STAR_RULES.coinHop(13, "R")).toBe(2);
    expect(STAR_RULES.coinHop(14, "B")).toBe(1);
    expect(STAR_RULES.coinHop(14, "N")).toBe(3);
    expect(STAR_RULES.coinHop(15, "N")).toBe(2);
    expect(STAR_RULES.coinHop(20, "K")).toBe(2);
    expect(STAR_RULES.coinHop(21, "P")).toBe(1);
  });
  it("pawnWars", () => {
    expect(STAR_RULES.pawnWars(true)).toBe(3);
    expect(STAR_RULES.pawnWars(false)).toBe(1);
  });
  it("packStars (mate packs, tier-2 tactics)", () => {
    expect(STAR_RULES.packStars(12)).toBe(3);
    expect(STAR_RULES.packStars(11)).toBe(2);
    expect(STAR_RULES.packStars(8)).toBe(2);
    expect(STAR_RULES.packStars(7)).toBe(1);
    expect(STAR_RULES.packStars(4)).toBe(1);
    expect(STAR_RULES.packStars(3)).toBe(0);
  });
  it("hangingHunt", () => {
    expect(STAR_RULES.hangingHunt(8)).toBe(3);
    expect(STAR_RULES.hangingHunt(7)).toBe(2);
    expect(STAR_RULES.hangingHunt(5)).toBe(2);
    expect(STAR_RULES.hangingHunt(4)).toBe(1);
    expect(STAR_RULES.hangingHunt(3)).toBe(1);
    expect(STAR_RULES.hangingHunt(2)).toBe(0);
  });
  it("tacticTier1 (13 cases total)", () => {
    expect(STAR_RULES.tacticTier1(13)).toBe(3);
    expect(STAR_RULES.tacticTier1(12)).toBe(2);
    expect(STAR_RULES.tacticTier1(8)).toBe(2);
    expect(STAR_RULES.tacticTier1(7)).toBe(1);
    expect(STAR_RULES.tacticTier1(4)).toBe(1);
    expect(STAR_RULES.tacticTier1(3)).toBe(0);
  });
  it("rookMaze vs par", () => {
    expect(STAR_RULES.rookMaze(5, 5)).toBe(3);
    expect(STAR_RULES.rookMaze(6, 5)).toBe(2);
    expect(STAR_RULES.rookMaze(7, 5)).toBe(1);
  });
});
