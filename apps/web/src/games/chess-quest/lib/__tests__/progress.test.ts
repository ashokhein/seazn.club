import { describe, expect, it } from "vitest";
import { createProgressState } from "../progress";

// Minimal in-memory Storage for the persistence tests.
function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    key: (i) => Array.from(map.keys())[i] ?? null,
    removeItem: (k) => void map.delete(k),
    setItem: (k, v) => void map.set(k, String(v)),
  };
}

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

describe("profiles store (Phase D)", () => {
  it("starts with one classic profile, empty name", () => {
    const p = createProgressState();
    expect(p.profiles()).toHaveLength(1);
    expect(p.activeId()).toBe("p1");
    expect(p.getMode()).toBe("classic"); // public-site default
    expect(p.getName()).toBe("");
  });

  it("add / switch / isolation / remove", () => {
    const p = createProgressState();
    p.setName("Mila");
    p.setWeekDone(1, true);
    const id2 = p.addProfile("Dad", "classic");
    expect(p.activeId()).toBe(id2);
    expect(p.getName()).toBe("Dad");
    expect(p.getMode()).toBe("classic");
    expect(p.isWeekDone(1)).toBe(false); // isolated
    p.switchProfile("p1");
    expect(p.getName()).toBe("Mila");
    expect(p.isWeekDone(1)).toBe(true);
    expect(p.profiles()).toHaveLength(2);
    // remove non-active
    expect(p.removeProfile(id2)).toBe(true);
    expect(p.profiles()).toHaveLength(1);
    // refuses to remove the only one
    expect(p.removeProfile("p1")).toBe(false);
  });

  it("removing the active profile switches to a survivor", () => {
    const p = createProgressState();
    const id2 = p.addProfile("Dad", "classic");
    expect(p.activeId()).toBe(id2);
    p.removeProfile(id2);
    expect(p.activeId()).toBe("p1");
    expect(p.profiles()).toHaveLength(1);
  });

  it("addProfile never mutates existing profiles", () => {
    const p = createProgressState();
    p.setName("Mila");
    p.setMode("story");
    p.addProfile("Dad", "classic");
    p.switchProfile("p1");
    expect(p.getMode()).toBe("story");
    expect(p.getName()).toBe("Mila");
  });

  it("setMode only touches the active profile", () => {
    const p = createProgressState();
    p.setMode("story");
    expect(p.getMode()).toBe("story");
  });
});

describe("lessons + tracks", () => {
  it("weeks done, current stop, land + track counts", () => {
    const p = createProgressState();
    expect(p.weeksDone()).toBe(0);
    expect(p.currentWeek(48)).toBe(1);
    p.setWeekDone(1, true);
    p.setWeekDone(2, true);
    p.setWeekDone(25, true);
    expect(p.weeksDone()).toBe(3);
    expect(p.currentWeek(48)).toBe(26); // highest done (25) + 1
    expect(p.landDone({ weeks: [1, 4] })).toBe(false);
    expect(p.trackDone(1)).toBe(2);
    expect(p.trackDone(2)).toBe(1);
    p.setWeekDone(2, false);
    expect(p.isWeekDone(2)).toBe(false);
    expect(p.weeksDone()).toBe(2);
  });

  it("totalStars = weeks done + game stars", () => {
    const p = createProgressState();
    p.setWeekDone(1, true);
    p.setGameStars("coinHop", 3);
    p.setGameStars("squareRace", 2);
    expect(p.totalStars()).toBe(1 + 3 + 2);
  });
});

describe("activity + streak", () => {
  it("empty streak is 0; markActivity dedupes", () => {
    const p = createProgressState();
    expect(p.streak("2026-07-12")).toBe(0);
    p.markActivity("2026-07-12");
    p.markActivity("2026-07-12");
    expect(p.activityDates()).toHaveLength(1);
  });

  it("chain with <=2-day gaps counts; dies after 3 quiet days", () => {
    const p = createProgressState();
    p.markActivity("2026-07-08");
    p.markActivity("2026-07-10");
    p.markActivity("2026-07-12");
    expect(p.streak("2026-07-12")).toBe(3);
    expect(p.streak("2026-07-14")).toBe(3); // still alive 2 days later
    expect(p.streak("2026-07-15")).toBe(0); // dead after 3 quiet days
  });
});

describe("persistence", () => {
  it("survives a reload against the same storage", () => {
    const storage = fakeStorage();
    const p = createProgressState(storage);
    p.setName("Dad");
    p.setWeekDone(3, true);
    p.setGameStars("mateInOne", 2);
    const id2 = p.addProfile("Kid", "story");

    const reloaded = createProgressState(storage);
    expect(reloaded.activeId()).toBe(id2);
    expect(reloaded.profiles()).toHaveLength(2);
    reloaded.switchProfile("p1");
    expect(reloaded.getName()).toBe("Dad");
    expect(reloaded.isWeekDone(3)).toBe(true);
    expect(reloaded.gameStars("mateInOne")).toBe(2);
  });

  it("recovers from a corrupt blob", () => {
    const storage = fakeStorage();
    storage.setItem("seazn-games:chess-quest:v1", "{not json");
    const p = createProgressState(storage);
    expect(p.profiles()).toHaveLength(1);
    expect(p.getName()).toBe("");
  });
});
