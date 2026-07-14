"use client";

// Session progress store. Phase C keeps it in memory; Phase D swaps the
// provider internals for localStorage-backed profiles. The Progress API is
// the contract — game components must not reach around it.
import { createContext, useContext, useMemo, useRef, useState } from "react";

export type Progress = {
  isSolved(i: number): boolean;
  setSolved(i: number): void;
  solvedCount(): number;
  resetPuzzles(): void;
  isSolved2(i: number): boolean;
  setSolved2(i: number): void;
  solved2Count(): number;
  resetPuzzles2(): void;
  isHuntSolved(i: number): boolean;
  setHuntSolved(i: number): void;
  huntCount(): number;
  resetHunts(): void;
  isTacticSolved(pack: string, i: number): boolean;
  setTacticSolved(pack: string, i: number): void;
  tacticCount(pack: string): number;
  resetTactics(pack: string): void;
  setGameStars(gameId: string, stars: number): void; // keep-max semantics
  gameStars(gameId: string): number;
  setBest(gameId: string, score: number): boolean; // true = new record
  getBest(gameId: string): number;
};

export function createProgressState(): Progress {
  const solved = new Set<number>();
  const solved2 = new Set<number>();
  const hunts = new Set<number>();
  const tactics: Record<string, Set<number>> = {};
  const stars: Record<string, number> = {};
  const bests: Record<string, number> = {};
  const packOf = (pack: string) => (tactics[pack] ??= new Set());

  return {
    isSolved: (i) => solved.has(i),
    setSolved: (i) => void solved.add(i),
    solvedCount: () => solved.size,
    resetPuzzles: () => solved.clear(),
    isSolved2: (i) => solved2.has(i),
    setSolved2: (i) => void solved2.add(i),
    solved2Count: () => solved2.size,
    resetPuzzles2: () => solved2.clear(),
    isHuntSolved: (i) => hunts.has(i),
    setHuntSolved: (i) => void hunts.add(i),
    huntCount: () => hunts.size,
    resetHunts: () => hunts.clear(),
    isTacticSolved: (pack, i) => packOf(pack).has(i),
    setTacticSolved: (pack, i) => void packOf(pack).add(i),
    tacticCount: (pack) => packOf(pack).size,
    resetTactics: (pack) => packOf(pack).clear(),
    setGameStars: (id, s) => {
      stars[id] = Math.max(stars[id] ?? 0, s);
    },
    gameStars: (id) => stars[id] ?? 0,
    setBest: (id, score) => {
      if (score > (bests[id] ?? 0)) {
        bests[id] = score;
        return true;
      }
      return false;
    },
    getBest: (id) => bests[id] ?? 0,
  };
}

const ProgressCtx = createContext<Progress | null>(null);

// Mutators bump a version counter so consumers re-render on writes.
const MUTATORS = [
  "setSolved",
  "resetPuzzles",
  "setSolved2",
  "resetPuzzles2",
  "setHuntSolved",
  "resetHunts",
  "setTacticSolved",
  "resetTactics",
  "setGameStars",
  "setBest",
] as const;

export function ProgressProvider({ children }: { children: React.ReactNode }) {
  const ref = useRef<Progress | null>(null);
  ref.current ??= createProgressState();
  const [, setVersion] = useState(0);

  const value = useMemo(() => {
    const inner = ref.current!;
    const wrapped = { ...inner };
    for (const m of MUTATORS) {
      const fn = inner[m] as (...args: never[]) => unknown;
      (wrapped as Record<string, unknown>)[m] = (...args: never[]) => {
        const out = fn(...args);
        setVersion((v) => v + 1);
        return out;
      };
    }
    return wrapped as Progress;
  }, []);

  return <ProgressCtx.Provider value={value}>{children}</ProgressCtx.Provider>;
}

export function useProgress(): Progress {
  const ctx = useContext(ProgressCtx);
  if (!ctx) throw new Error("useProgress needs a ProgressProvider");
  return ctx;
}
