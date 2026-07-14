"use client";

// Chess Quest progress — localStorage-backed player profiles. Each profile
// keeps its own lessons, stars, puzzle progress, activity streak and copy
// register. Ported from the standalone app's Store (chess-quest js/store.js),
// minus the v1 migration (Seazn is a fresh origin, so key + data start clean).
// The game-facing members (isSolved/setGameStars/setBest/…) match Phase C so
// the eight mini-games keep working unchanged.
import { createContext, useContext, useMemo, useState } from "react";

const KEY = "seazn-games:chess-quest:v1";

export type Mode = "story" | "classic";

type Profile = {
  name: string;
  mode: Mode;
  weeks: Record<number, boolean>;
  stars: Record<string, number>;
  best: Record<string, number>;
  solved: number[];
  solved2: number[];
  hunts: number[];
  tactics: Record<string, number[]>;
  activity: string[];
  created: string;
};

type Blob = { active: string; seq: number; profiles: Record<string, Profile> };

export type Progress = {
  // puzzle packs (Phase C contract — unchanged)
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
  setGameStars(gameId: string, stars: number): void;
  gameStars(gameId: string): number;
  setBest(gameId: string, score: number): boolean;
  getBest(gameId: string): number;

  // lessons
  isWeekDone(n: number): boolean;
  setWeekDone(n: number, done: boolean): void;
  weeksDone(): number;
  currentWeek(total: number): number;
  landDone(land: { weeks: [number, number] }): boolean;
  trackDone(track: 1 | 2): number;

  // activity / streak
  markActivity(dateISO?: string): void;
  activityDates(): string[];
  streak(todayISO?: string): number;

  // identity + register
  getName(): string;
  setName(n: string): void;
  getMode(): Mode;
  setMode(m: Mode): void;
  totalStars(): number;

  // profiles
  profiles(): { id: string; name: string; mode: Mode }[];
  activeId(): string;
  addProfile(name: string, mode: Mode): string;
  switchProfile(id: string): boolean;
  removeProfile(id: string): boolean;
};

function todayISO(): string {
  const d = new Date();
  return (
    d.getFullYear() +
    "-" +
    String(d.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(d.getDate()).padStart(2, "0")
  );
}

function dayNum(iso: string): number {
  return Math.round(Date.parse(iso + "T00:00:00Z") / 86400000);
}

function blankProfile(): Profile {
  return {
    name: "",
    mode: "story",
    weeks: {},
    stars: {},
    best: {},
    solved: [],
    solved2: [],
    hunts: [],
    tactics: {},
    activity: [],
    created: todayISO(),
  };
}

function freshBlob(): Blob {
  return { active: "p1", seq: 1, profiles: { p1: blankProfile() } };
}

function loadBlob(storage?: Storage): Blob {
  if (!storage) return freshBlob();
  let data: Blob | null = null;
  try {
    const raw = storage.getItem(KEY);
    if (raw) data = JSON.parse(raw) as Blob;
  } catch {
    console.warn("[chess-quest] discarding corrupt progress blob");
  }
  if (!data || !data.profiles) return freshBlob();
  // Backfill any missing fields on older blobs.
  for (const id in data.profiles) {
    data.profiles[id] = { ...blankProfile(), ...data.profiles[id] };
  }
  if (!data.profiles[data.active]) data.active = Object.keys(data.profiles)[0];
  return data;
}

export function createProgressState(storage?: Storage): Progress {
  const data = loadBlob(storage);
  const P = () => data.profiles[data.active];

  function save() {
    if (!storage) return;
    try {
      storage.setItem(KEY, JSON.stringify(data));
    } catch {
      /* private mode — run without persistence */
    }
  }

  // Any real play counts toward today's streak.
  function touch() {
    const d = todayISO();
    if (!P().activity.includes(d)) P().activity.push(d);
  }

  const packOf = (pack: string) => (P().tactics[pack] ??= []);

  return {
    isSolved: (i) => P().solved.includes(i),
    setSolved: (i) => {
      if (!P().solved.includes(i)) {
        P().solved.push(i);
        touch();
        save();
      }
    },
    solvedCount: () => P().solved.length,
    resetPuzzles: () => {
      P().solved = [];
      save();
    },
    isSolved2: (i) => P().solved2.includes(i),
    setSolved2: (i) => {
      if (!P().solved2.includes(i)) {
        P().solved2.push(i);
        touch();
        save();
      }
    },
    solved2Count: () => P().solved2.length,
    resetPuzzles2: () => {
      P().solved2 = [];
      save();
    },
    isHuntSolved: (i) => P().hunts.includes(i),
    setHuntSolved: (i) => {
      if (!P().hunts.includes(i)) {
        P().hunts.push(i);
        touch();
        save();
      }
    },
    huntCount: () => P().hunts.length,
    resetHunts: () => {
      P().hunts = [];
      save();
    },
    isTacticSolved: (pack, i) => packOf(pack).includes(i),
    setTacticSolved: (pack, i) => {
      if (!packOf(pack).includes(i)) {
        packOf(pack).push(i);
        touch();
        save();
      }
    },
    tacticCount: (pack) => packOf(pack).length,
    resetTactics: (pack) => {
      P().tactics[pack] = [];
      save();
    },
    setGameStars: (id, s) => {
      if (s > (P().stars[id] ?? 0)) P().stars[id] = s;
      touch();
      save();
    },
    gameStars: (id) => P().stars[id] ?? 0,
    setBest: (id, score) => {
      if (score > (P().best[id] ?? 0)) {
        P().best[id] = score;
        touch();
        save();
        return true;
      }
      return false;
    },
    getBest: (id) => P().best[id] ?? 0,

    isWeekDone: (n) => !!P().weeks[n],
    setWeekDone: (n, done) => {
      if (done) {
        P().weeks[n] = true;
        touch();
      } else {
        delete P().weeks[n];
      }
      save();
    },
    weeksDone: () => Object.keys(P().weeks).length,
    currentWeek: (total) => {
      let cur = 1;
      for (let i = 1; i <= total; i++) if (P().weeks[i]) cur = Math.min(i + 1, total);
      return cur;
    },
    landDone: (land) => {
      for (let i = land.weeks[0]; i <= land.weeks[1]; i++) if (!P().weeks[i]) return false;
      return true;
    },
    trackDone: (track) => {
      const lo = track === 2 ? 25 : 1;
      const hi = track === 2 ? 48 : 24;
      let n = 0;
      for (let i = lo; i <= hi; i++) if (P().weeks[i]) n++;
      return n;
    },

    markActivity: (dateISO) => {
      const d = dateISO || todayISO();
      if (!P().activity.includes(d)) {
        P().activity.push(d);
        save();
      }
    },
    activityDates: () => P().activity.slice(),
    // Streak of play-days: alive while gaps stay ≤ 2 days (the quest runs
    // every other day, so one rest day never breaks it).
    streak: (todayStr) => {
      const t = dayNum(todayStr || todayISO());
      const days = [...new Set(P().activity)].map(dayNum).sort((a, b) => b - a);
      if (!days.length || t - days[0] > 2) return 0;
      let n = 1;
      for (let i = 1; i < days.length && days[i - 1] - days[i] <= 2; i++) n++;
      return n;
    },

    getName: () => P().name || "",
    setName: (n) => {
      P().name = String(n || "").trim().slice(0, 16);
      save();
    },
    getMode: () => P().mode,
    setMode: (m) => {
      P().mode = m === "classic" ? "classic" : "story";
      save();
    },
    totalStars: () => {
      let s = Object.keys(P().weeks).length;
      for (const k in P().stars) s += P().stars[k];
      return s;
    },

    profiles: () =>
      Object.keys(data.profiles).map((id) => ({
        id,
        name: data.profiles[id].name,
        mode: data.profiles[id].mode,
      })),
    activeId: () => data.active,
    addProfile: (name, mode) => {
      const id = "p" + ++data.seq;
      const prof = blankProfile();
      prof.name = String(name || "").trim().slice(0, 16);
      prof.mode = mode === "classic" ? "classic" : "story";
      data.profiles[id] = prof;
      data.active = id;
      save();
      return id;
    },
    switchProfile: (id) => {
      if (!data.profiles[id]) return false;
      data.active = id;
      save();
      return true;
    },
    removeProfile: (id) => {
      if (!data.profiles[id] || Object.keys(data.profiles).length <= 1) return false;
      delete data.profiles[id];
      if (data.active === id) data.active = Object.keys(data.profiles)[0];
      save();
      return true;
    },
  };
}

const ProgressCtx = createContext<Progress | null>(null);

// Every mutator bumps a version counter so consumers re-render on writes.
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
  "setWeekDone",
  "markActivity",
  "setName",
  "setMode",
  "addProfile",
  "switchProfile",
  "removeProfile",
] as const;

export function ProgressProvider({ children }: { children: React.ReactNode }) {
  // The whole chess-quest tree loads via next/dynamic({ ssr: false }), so this
  // only ever renders in the browser — safe to read localStorage at init.
  const [inner] = useState<Progress>(() =>
    createProgressState(typeof window !== "undefined" ? window.localStorage : undefined),
  );
  const [, setVersion] = useState(0);

  const value = useMemo(() => {
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
  }, [inner]);

  return <ProgressCtx.Provider value={value}>{children}</ProgressCtx.Provider>;
}

export function useProgress(): Progress {
  const ctx = useContext(ProgressCtx);
  if (!ctx) throw new Error("useProgress needs a ProgressProvider");
  return ctx;
}
