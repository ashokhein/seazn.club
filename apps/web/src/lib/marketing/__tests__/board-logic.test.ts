import { describe, expect, it } from "vitest";
import { createBoard, place, isFull } from "../board-logic";

const fixtures = ["Falcons v Comets", "Tigers v Rovers", "Aces v Smash"];

describe("board logic", () => {
  it("placing moves a fixture from tray to court", () => {
    const s1 = place(createBoard(fixtures, 3), 0, 1);
    expect(s1.tray).toEqual(["Tigers v Rovers", "Aces v Smash"]);
    expect(s1.courts[1]!.placed).toEqual(["Falcons v Comets"]);
    expect(s1.courts[1]!.clash).toBe(false);
  });
  it("two fixtures on one court is a clash", () => {
    const s = place(place(createBoard(fixtures, 3), 0, 0), 0, 0);
    expect(s.courts[0]!.placed).toHaveLength(2);
    expect(s.courts[0]!.clash).toBe(true);
  });
  it("out-of-range placements are no-ops", () => {
    const s0 = createBoard(fixtures, 3);
    expect(place(s0, 9, 0)).toBe(s0);
    expect(place(s0, 0, 9)).toBe(s0);
  });
  it("board is full when the tray is empty and no clash", () => {
    let s = createBoard(fixtures, 3);
    s = place(s, 0, 0);
    s = place(s, 0, 1);
    expect(isFull(s)).toBe(false);
    s = place(s, 0, 2);
    expect(isFull(s)).toBe(true);
    const clashed = place(place(createBoard(fixtures.slice(0, 2), 2), 0, 0), 0, 0);
    expect(isFull(clashed)).toBe(false);
  });
});
