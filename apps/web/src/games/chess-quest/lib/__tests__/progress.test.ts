import { describe, expect, it } from "vitest";
import { createProgressState } from "../progress";

describe("progress store (session-only; Phase D swaps persistence)", () => {
  it("mate-in-1 pack solve/count/reset", () => {
    const p = createProgressState();
    expect(p.isSolved(0)).toBe(false);
    p.setSolved(0);
    p.setSolved(5);
    p.setSolved(5); // idempotent
    expect(p.isSolved(0)).toBe(true);
    expect(p.solvedCount()).toBe(2);
    p.resetPuzzles();
    expect(p.solvedCount()).toBe(0);
  });
  it("mate-in-2 pack is independent", () => {
    const p = createProgressState();
    p.setSolved(1);
    p.setSolved2(1);
    expect(p.solved2Count()).toBe(1);
    p.resetPuzzles2();
    expect(p.solved2Count()).toBe(0);
    expect(p.solvedCount()).toBe(1);
  });
  it("hunts", () => {
    const p = createProgressState();
    p.setHuntSolved(3);
    expect(p.isHuntSolved(3)).toBe(true);
    expect(p.huntCount()).toBe(1);
    p.resetHunts();
    expect(p.huntCount()).toBe(0);
  });
  it("tactics per pack", () => {
    const p = createProgressState();
    p.setTacticSolved("fork", 0);
    p.setTacticSolved("fork", 2);
    p.setTacticSolved("pin2", 1);
    expect(p.tacticCount("fork")).toBe(2);
    expect(p.tacticCount("pin2")).toBe(1);
    expect(p.isTacticSolved("fork", 2)).toBe(true);
    p.resetTactics("fork");
    expect(p.tacticCount("fork")).toBe(0);
    expect(p.tacticCount("pin2")).toBe(1);
  });
  it("game stars keep the max", () => {
    const p = createProgressState();
    p.setGameStars("squareRace", 2);
    p.setGameStars("squareRace", 1);
    expect(p.gameStars("squareRace")).toBe(2);
    p.setGameStars("squareRace", 3);
    expect(p.gameStars("squareRace")).toBe(3);
  });
  it("bests: new record only on strict improvement", () => {
    const p = createProgressState();
    expect(p.setBest("squareRace", 5)).toBe(true);
    expect(p.setBest("squareRace", 5)).toBe(false);
    expect(p.setBest("squareRace", 4)).toBe(false);
    expect(p.setBest("squareRace", 6)).toBe(true);
    expect(p.getBest("squareRace")).toBe(6);
  });
});
