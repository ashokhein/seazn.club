# Chess Quest — Track 3 (Opening Range) + Opening Trainer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a playable opening-technique track — a new Opening Trainer mini-game, a Track 3 "Opening Range" land with 5 lessons, and wire the two existing instruction-only Italian lessons (19, 31) to the trainer.

**Architecture:** New pure `content/openings.ts` data (engine-legal mainlines, ≤5 plies, no castling); a new `OpeningTrainer` React game that drills a line move-by-move; content/store/map/progress/certificate extended from 48→53 lessons and 9→10 lands. The two UI extras (footer link, centered header) already landed on this branch.

**Tech Stack:** React 19 client components, TypeScript, engine barrel (`../engine`), Vitest, Playwright. All new code under `apps/web/src/games/chess-quest/`.

**Spec:** `docs/superpowers/specs/2026-07-14-chess-quest-track3-openings-design.md`. Worktree/branch `worktree-games-track3` (forked from main 5844b32).

## Global Constraints

- All new code under `apps/web/src/games/chess-quest/`; every component starts with `"use client"`. Engine from `../engine`, content from `../content/*`.
- **Engine has no castling/en passant/promotion-choice** — every opening line is 3–5 development plies using only ordinary moves + captures. Do not add engine features.
- Opening lines are a single mainline; a wrong move just retries (no transpositions).
- Star/copy/register conventions unchanged from the existing games (keep-max stars; `useCopy().t(story, classic)`; `Rich` for markup; celebrate = fanfare + confetti; `voice.say` on wins).
- Timers via `useLater()`. Tap-tap move selection like the other games.
- Run suites with `rtk proxy npx vitest run …` from `apps/web`. Conventional commits, `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Content verification is the acceptance gate for the lines — do not weaken a detector/verifier to make a line pass; fix the line data.

---

### Task 1: Openings data + verification

**Files:**
- Create: `apps/web/src/games/chess-quest/content/openings.ts`
- Test: `apps/web/src/games/chess-quest/content/__tests__/openings.test.ts`

**Interfaces:**
- Produces (consumed by Tasks 2, 4, 6): `type OpeningMove = { from: string; to: string; san: string }`; `type Opening = { id: string; name: string; learnerSide: "white" | "black"; line: OpeningMove[]; idea: string }`; `const OPENINGS: Record<string, Opening>`; `const OPENING_IDS: string[]`.

- [ ] **Step 1: Write the failing verification test**

```ts
// apps/web/src/games/chess-quest/content/__tests__/openings.test.ts
import { describe, expect, it } from "vitest";
import { isWhitePiece, legalTargets, applyMove, parseFEN, sqIdx } from "../../engine";
import { OPENINGS, OPENING_IDS } from "../openings";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

describe("openings are engine-legal mainlines", () => {
  it("has the five classic-set openings", () => {
    expect(OPENING_IDS.sort()).toEqual(
      ["italian", "london", "ruyLopez", "scandinavian", "scotch"].sort(),
    );
  });

  it.each(OPENING_IDS.map((id) => [id, OPENINGS[id]] as const))("%s replays legally", (_id, op) => {
    let board = parseFEN(START).board;
    let whiteToMove = true;
    let firstLearnerSide: "white" | "black" | null = null;
    for (const mv of op.line) {
      const from = sqIdx(mv.from);
      const to = sqIdx(mv.to);
      // the mover owns the piece on `from`
      expect(board[from]).not.toBe("");
      expect(isWhitePiece(board[from])).toBe(whiteToMove);
      // the move is legal
      expect(legalTargets(board, from), `${op.id} ${mv.san}`).toContain(to);
      if (firstLearnerSide === null && (whiteToMove ? "white" : "black") === op.learnerSide) {
        firstLearnerSide = whiteToMove ? "white" : "black";
      }
      board = applyMove(board, from, to);
      whiteToMove = !whiteToMove;
    }
    // the learner actually moves in this line
    expect(op.line.some((_, i) => (i % 2 === 0) === (op.learnerSide === "white"))).toBe(true);
    expect(op.idea.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run → fail**

Run: `rtk proxy npx vitest run src/games/chess-quest/content/__tests__/openings.test.ts`
Expected: FAIL — cannot resolve `../openings`.

- [ ] **Step 3: Implement openings.ts**

```ts
// apps/web/src/games/chess-quest/content/openings.ts
// Opening mainlines for the Opening Trainer. Each line is 3–5 development plies
// (no castling — the engine doesn't model it, and the setup is the beginner
// takeaway). Every move is verified engine-legal by content/__tests__.

export type OpeningMove = { from: string; to: string; san: string };
export type Opening = {
  id: string;
  name: string;
  learnerSide: "white" | "black";
  line: OpeningMove[]; // full sequence, both sides, in play order
  idea: string;
};

const m = (from: string, to: string, san: string): OpeningMove => ({ from, to, san });

export const OPENINGS: Record<string, Opening> = {
  italian: {
    id: "italian",
    name: "The Italian Game",
    learnerSide: "white",
    line: [
      m("e2", "e4", "e4"),
      m("e7", "e5", "e5"),
      m("g1", "f3", "Nf3"),
      m("b8", "c6", "Nc6"),
      m("f1", "c4", "Bc4"),
      m("f8", "c5", "Bc5"),
    ],
    idea: "Take the centre, aim the bishop at f7, and get ready to castle.",
  },
  ruyLopez: {
    id: "ruyLopez",
    name: "The Ruy Lopez",
    learnerSide: "white",
    line: [
      m("e2", "e4", "e4"),
      m("e7", "e5", "e5"),
      m("g1", "f3", "Nf3"),
      m("b8", "c6", "Nc6"),
      m("f1", "b5", "Bb5"),
      m("a7", "a6", "a6"),
    ],
    idea: "Pin the knight that guards e5 — long-term pressure on Black's centre.",
  },
  scotch: {
    id: "scotch",
    name: "The Scotch Game",
    learnerSide: "white",
    line: [
      m("e2", "e4", "e4"),
      m("e7", "e5", "e5"),
      m("g1", "f3", "Nf3"),
      m("b8", "c6", "Nc6"),
      m("d2", "d4", "d4"),
      m("e5", "d4", "exd4"),
      m("f3", "d4", "Nxd4"),
    ],
    idea: "Blast the centre open early and get a big lead in development.",
  },
  london: {
    id: "london",
    name: "The London System",
    learnerSide: "white",
    line: [
      m("d2", "d4", "d4"),
      m("d7", "d5", "d5"),
      m("g1", "f3", "Nf3"),
      m("g8", "f6", "Nf6"),
      m("c1", "f4", "Bf4"),
    ],
    idea: "A calm, solid setup you can play against almost anything.",
  },
  scandinavian: {
    id: "scandinavian",
    name: "The Scandinavian Defense",
    learnerSide: "black",
    line: [
      m("e2", "e4", "e4"),
      m("d7", "d5", "d5"),
      m("e4", "d5", "exd5"),
      m("d8", "d5", "Qxd5"),
      m("b1", "c3", "Nc3"),
      m("d5", "a5", "Qa5"),
    ],
    idea: "Hit the centre at once as Black — then tuck the queen safely on a5.",
  },
};

export const OPENING_IDS = Object.keys(OPENINGS);
```

- [ ] **Step 4: Run → pass**

Run: `rtk proxy npx vitest run src/games/chess-quest/content/__tests__/openings.test.ts`
Expected: PASS (6 tests: the count + 5 lines). If a line fails legality, fix the FEN/move data — not the test.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/games/chess-quest/content/openings.ts apps/web/src/games/chess-quest/content/__tests__/openings.test.ts
git commit -m "feat(chess-quest): opening mainlines + engine-legal verification

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Opening Trainer star rule

**Files:**
- Modify: `apps/web/src/games/chess-quest/lib/stars.ts`
- Test: `apps/web/src/games/chess-quest/lib/__tests__/stars.test.ts` (extend)

**Interfaces:**
- Produces: `STAR_RULES.openingTrainer(mistakes: number): number` — 0 → 3, 1–2 → 2, else 1.

- [ ] **Step 1: Extend the failing test** — add to `stars.test.ts`:

```ts
  it("openingTrainer by mistakes", () => {
    expect(STAR_RULES.openingTrainer(0)).toBe(3);
    expect(STAR_RULES.openingTrainer(1)).toBe(2);
    expect(STAR_RULES.openingTrainer(2)).toBe(2);
    expect(STAR_RULES.openingTrainer(3)).toBe(1);
  });
```

- [ ] **Step 2: Run → fail** (`rtk proxy npx vitest run src/games/chess-quest/lib/__tests__/stars.test.ts`) — `openingTrainer` undefined.

- [ ] **Step 3: Implement** — add to the `STAR_RULES` object in `lib/stars.ts`:

```ts
  openingTrainer(mistakes: number): number {
    return mistakes === 0 ? 3 : mistakes <= 2 ? 2 : 1;
  },
```

- [ ] **Step 4: Run → pass.**
- [ ] **Step 5: Commit** `feat(chess-quest): opening-trainer star rule`.

---

### Task 3: Opening Trainer game component

**Files:**
- Create: `apps/web/src/games/chess-quest/components/games/OpeningTrainer.tsx`

**Interfaces:**
- Consumes: `OPENINGS` (Task 1), `STAR_RULES.openingTrainer` (Task 2), engine barrel, `Board`/`GameShell`/`Rich`, `celebrate`, `voice`, `sfx`, `useProgress`, `useLater`, `useCopy`.
- Produces: `export function OpeningTrainer({ opening }: { opening: string }): JSX.Element` — consumed by Task 6.

**Behavior contract:** start from the standard position; walk `OPENINGS[opening].line` by ply. Opponent plies (side ≠ `learnerSide`) auto-play after ~550ms via `later()` with a highlight. On a learner ply, highlight the from-square as a hint and accept a tap-tap move: if it matches `line[ply]` → `applyMove`, `sfx.move`, advance, schedule the next opponent reply; else `sfx.bad`, shake, coach nudge, `mistakes++`, board unchanged (retry). At line end → `celebrate()`, `voice.say(name + " — you played the whole line!")`, `setGameStars("openingTrainer", STAR_RULES.openingTrainer(mistakes))`, offer "Play again" (resets ply/board/mistakes). HUD: `{name}` + `move {doneLearnerMoves}/{totalLearnerMoves}`; the opening's `idea` renders under the status.

- [ ] **Step 1: Implement the component**

```tsx
// apps/web/src/games/chess-quest/components/games/OpeningTrainer.tsx
"use client";

// Opening Trainer — play a named opening move by move. The trainer auto-plays
// the book replies; you play your side's moves until the line is complete.
// Repetition builds the opening into muscle memory ("play it fifty times").
import { useCallback, useEffect, useState } from "react";
import { applyMove, isWhitePiece, legalTargets, parseFEN, sqIdx } from "../../engine";
import { OPENINGS } from "../../content/openings";
import { celebrate } from "../../lib/celebrate";
import { sfx } from "../../lib/sfx";
import { STAR_RULES } from "../../lib/stars";
import { useLater } from "../../lib/use-later";
import { useProgress } from "../../lib/progress";
import { voice } from "../../lib/voice";
import { Board, Highlight } from "../Board";
import { GameShell } from "../GameShell";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

export function OpeningTrainer({ opening }: { opening: string }) {
  const op = OPENINGS[opening] ?? OPENINGS.italian;
  const progress = useProgress();
  const { later, clearPending } = useLater();

  const [position, setPosition] = useState<string[]>(() => parseFEN(START).board);
  const [ply, setPly] = useState(0);
  const [selIdx, setSelIdx] = useState(-1);
  const [mistakes, setMistakes] = useState(0);
  const [done, setDone] = useState(false);
  const [highlights, setHighlights] = useState<Partial<Record<number, Highlight>>>({});
  const [pop, setPop] = useState<{ idx: number; n: number } | null>(null);
  const [popN, setPopN] = useState(0);
  const [shake, setShake] = useState(0);
  const [status, setStatus] = useState("");

  const learnerMovesTotal = op.line.filter(
    (_, i) => (i % 2 === 0) === (op.learnerSide === "white"),
  ).length;

  const learnerPly = (i: number) => (i % 2 === 0) === (op.learnerSide === "white");

  const promptFor = useCallback(
    (i: number) => {
      if (i >= op.line.length) return `<strong>${op.name}</strong> — line complete!`;
      return learnerPly(i)
        ? `Your move: play <strong>${op.line[i].san}</strong>. Tap the glowing piece, then its square.`
        : `<strong>${op.name}</strong> — watch the reply…`;
    },
    // op is stable per opening prop
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [op],
  );

  // Reset to the start of the line.
  const reset = useCallback(() => {
    clearPending();
    setPosition(parseFEN(START).board);
    setPly(0);
    setSelIdx(-1);
    setMistakes(0);
    setDone(false);
    setHighlights({});
    setStatus(promptFor(0));
  }, [clearPending, promptFor]);

  useEffect(() => {
    reset();
  }, [reset]);

  useEffect(() => () => clearPending(), [clearPending]);

  // Drive opponent auto-moves and highlight the learner's from-square.
  useEffect(() => {
    if (done || ply >= op.line.length) return;
    if (!learnerPly(ply)) {
      later(() => {
        setPosition((pos) => {
          const mv = op.line[ply];
          const next = applyMove(pos, sqIdx(mv.from), sqIdx(mv.to));
          return next;
        });
        const to = sqIdx(op.line[ply].to);
        setPop({ idx: to, n: popN + 1 });
        setPopN((v) => v + 1);
        sfx.move();
        setPly((p) => p + 1);
      }, 550);
    } else {
      // hint: glow the piece that should move
      setHighlights({ [sqIdx(op.line[ply].from)]: "hint" });
      setStatus(promptFor(ply));
    }
    // ply drives the sequence; other setters are stable
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ply, done]);

  function finish() {
    setDone(true);
    setHighlights({});
    const stars = STAR_RULES.openingTrainer(mistakes);
    progress.setGameStars("openingTrainer", stars);
    setStatus(`<strong>${op.name}</strong> — you played the whole line! ${"★".repeat(stars)}`);
    voice.say(`${op.name}. You played the whole line!`);
    celebrate();
  }

  function onLearnerMove(from: number, to: number) {
    const mv = op.line[ply];
    if (from === sqIdx(mv.from) && to === sqIdx(mv.to)) {
      const next = applyMove(position, from, to);
      setPosition(next);
      setPop({ idx: to, n: popN + 1 });
      setPopN((v) => v + 1);
      sfx.move();
      setSelIdx(-1);
      const nextPly = ply + 1;
      if (nextPly >= op.line.length) {
        setPly(nextPly);
        finish();
      } else {
        setPly(nextPly);
      }
    } else {
      setSelIdx(-1);
      setMistakes((x) => x + 1);
      setShake((s) => s + 1);
      sfx.bad();
      setStatus(
        `Not the book move — the ${op.name} plays <strong>${mv.san}</strong> here. Follow the glowing piece.`,
      );
      setHighlights({ [sqIdx(mv.from)]: "hint" });
    }
  }

  function onTap(idx: number) {
    if (done || ply >= op.line.length || !learnerPly(ply)) return;
    const pos = position;
    const p = pos[idx];
    const mine = p !== "" && isWhitePiece(p) === (op.learnerSide === "white");
    if (mine) {
      setSelIdx(idx);
      const hl: Partial<Record<number, Highlight>> = { [idx]: "sel" };
      for (const t of legalTargets(pos, idx)) hl[t] = pos[t] === "" ? "move" : "cap";
      // keep the book from-square glowing too
      hl[sqIdx(op.line[ply].from)] = "hint";
      setHighlights(hl);
      return;
    }
    if (selIdx >= 0 && legalTargets(pos, selIdx).includes(idx)) {
      onLearnerMove(selIdx, idx);
    } else if (selIdx >= 0) {
      setShake((s) => s + 1);
    }
  }

  const doneLearnerMoves = op.line
    .slice(0, ply)
    .filter((_, i) => learnerPly(i)).length;

  return (
    <GameShell
      title={`Opening Trainer — ${op.name}`}
      score={`move ${doneLearnerMoves}/${learnerMovesTotal}`}
      status={status}
      extra={<p className="text-center text-xs italic text-slate-500">{op.idea}</p>}
      controls={
        <button type="button" className="btn btn-ghost" onClick={reset}>
          {done ? "Play again" : "Restart"}
        </button>
      }
    >
      <Board
        position={position}
        labels
        highlights={highlights}
        popToken={pop}
        shakeToken={shake}
        onTap={onTap}
      />
    </GameShell>
  );
}
```

- [ ] **Step 2: Lint** — `rtk proxy npx eslint src/games/chess-quest/components/games/OpeningTrainer.tsx`; expect exit 0. Fix any real errors (the shake-animation warning class is tolerated elsewhere; avoid new ones).
- [ ] **Step 3: Commit** `feat(chess-quest): Opening Trainer game`.

---

### Task 4: Track 3 land + lessons + lesson 19/31 improvement

**Files:**
- Modify: `apps/web/src/games/chess-quest/content/lands.ts`
- Modify: `apps/web/src/games/chess-quest/content/lessons.ts`
- Modify: `apps/web/src/games/chess-quest/content/__tests__/curriculum.test.ts`

**Interfaces:**
- Consumes: `OPENINGS`/`OPENING_IDS` (Task 1) — lesson `gameOpts.opening` values must be in `OPENING_IDS`.
- Produces: `LANDS` length 10 (land id 10 track 3, weeks [49,53]); `LESSONS` length 53; `GameId` gains `"openingTrainer"`; lessons 19 & 31 `game: "openingTrainer"`.

- [ ] **Step 1: Update the curriculum test** to the new totals + an opening-lessons check:

Replace the "48 lessons" / "9 lands" / tiling expectations and add the openings check. In `curriculum.test.ts`:

```ts
import { OPENING_IDS } from "../openings";

const GAME_IDS = [
  "squareRace",
  "coinHop",
  "pawnWars",
  "mateInOne",
  "mateInTwo",
  "hangingHunt",
  "tacticTrainer",
  "rookMaze",
  "openingTrainer",
];
```

Update these assertions:
- `expect(LESSONS).toHaveLength(53);`
- `expect(LANDS).toHaveLength(10);`
- tiling loop bound `new Array(54)` and `seen.slice(1)` still all `=== 1`.
- add: track 3 lands cover 49–53:
```ts
  it("track 3 lands cover lessons 49..53 only", () => {
    for (const land of LANDS.filter((l) => l.track === 3)) {
      expect(land.weeks[0]).toBeGreaterThanOrEqual(49);
      expect(land.weeks[1]).toBeLessThanOrEqual(53);
    }
  });
```
- add: opening-trainer lessons point at a real opening:
```ts
  it("opening-trainer lessons name a real opening", () => {
    for (const l of LESSONS.filter((x) => x.game === "openingTrainer")) {
      const op = (l.gameOpts as { opening?: string } | undefined)?.opening ?? "";
      expect(OPENING_IDS, `lesson ${l.n}`).toContain(op);
    }
  });
```

- [ ] **Step 2: Run → fail** (`rtk proxy npx vitest run src/games/chess-quest/content/__tests__/curriculum.test.ts`) — length + game-id mismatches.

- [ ] **Step 3a: Add `openingTrainer` to `GameId`** in `lessons.ts`:

```ts
export type GameId =
  | "squareRace"
  | "coinHop"
  | "pawnWars"
  | "mateInOne"
  | "mateInTwo"
  | "hangingHunt"
  | "tacticTrainer"
  | "rookMaze"
  | "openingTrainer";
```

- [ ] **Step 3b: Wire lessons 19 and 31** — change their `game: null` to the trainer. In `lessons.ts` lesson 19 (`n: 19`, "Her First Opening"):

```ts
    game: "openingTrainer",
    gameOpts: { opening: "italian" },
```

(insert after the `title` line, replacing `game: null,`). Same for lesson 31 (`n: 31`, "The Italian, With a Plan"): `game: "openingTrainer", gameOpts: { opening: "italian" },`.

- [ ] **Step 3c: Append the Track 3 land** to `LANDS` in `lands.ts` (after land id 9):

```ts
  {
    id: 10,
    glyph: "♚",
    name: "Opening Range",
    weeks: [49, 53],
    track: 3,
    goal: "Turn opening rules into real repertoire — play five sound openings by hand.",
    check: "She plays the Italian, Ruy Lopez, Scotch, London and Scandinavian from memory.",
    checkClassic:
      "You reproduce five standard openings move-for-move and can state each one’s plan.",
  },
```

- [ ] **Step 3d: Append lessons 49–53** to `LESSONS` in `lessons.ts` (after lesson 48). Each lesson has both copy registers; keep it short (the trainer is the lesson):

```ts
  {
    n: 49,
    land: 10,
    title: "The Italian Game",
    game: "openingTrainer",
    gameOpts: { opening: "italian" },
    learn: "e4, Knight f3, Bishop c4 — the friendly Italian. The bishop stares at f7.",
    play: "Play the Italian in the trainer until the moves feel automatic. No reading — just play!",
    spark: "Same three moves every game. Soon your hands know them before your head does.",
    classic: {
      learn: "1.e4 e5 2.Nf3 Nc6 3.Bc4 Bc5 — the Italian: rapid development, pressure on f7.",
      play: "Drill the line in the trainer until it’s reflex, both the moves and the reason.",
      spark: "Repetition, not theory. One opening played fifty times beats five played ten.",
    },
  },
  {
    n: 50,
    land: 10,
    title: "The Ruy Lopez",
    game: "openingTrainer",
    gameOpts: { opening: "ruyLopez" },
    learn: "Like the Italian, but the bishop goes to b5 to bother the knight guarding e5.",
    play: "Play the Ruy Lopez line in the trainer. Feel how Bb5 pins the defender.",
    spark: "The “Spanish torture” — slow, sound pressure the pros still play today.",
    classic: {
      learn: "1.e4 e5 2.Nf3 Nc6 3.Bb5 a6 — the Ruy Lopez: pressure the e5 defender, keep long-term bind.",
      play: "Drill it; note how Bb5 targets the knight, not the pawn directly.",
      spark: "The most respected 1.e4 e5 opening — worth owning even at club level.",
    },
  },
  {
    n: 51,
    land: 10,
    title: "The Scotch Game",
    game: "openingTrainer",
    gameOpts: { opening: "scotch" },
    learn: "Punch the centre open early with d4, then grab the pawn back with the knight.",
    play: "Play the Scotch in the trainer: e4, Nf3, d4, take, take with the knight.",
    spark: "Open lines fast — great when you like lively, attacking games.",
    classic: {
      learn: "1.e4 e5 2.Nf3 Nc6 3.d4 exd4 4.Nxd4 — the Scotch: early central break, quick development lead.",
      play: "Drill the capture sequence until the recapture on d4 is automatic.",
      spark: "A clean way to avoid heavy Ruy Lopez theory while staying principled.",
    },
  },
  {
    n: 52,
    land: 10,
    title: "The London System",
    game: "openingTrainer",
    gameOpts: { opening: "london" },
    learn: "A calm setup with d4, Nf3 and the bishop out to f4 — plays against almost anything.",
    play: "Play the London in the trainer. Same easy setup, game after game.",
    spark: "Low-stress, high-reward: a system you can lean on when you’re tired.",
    classic: {
      learn: "1.d4 d5 2.Nf3 Nf6 3.Bf4 — the London: a solid, low-theory system with a clear plan.",
      play: "Drill the setup; the move order is flexible but the pieces always land the same.",
      spark: "Ideal one-system repertoire for busy players — minimal memorization.",
    },
  },
  {
    n: 53,
    land: 10,
    title: "The Scandinavian Defense",
    game: "openingTrainer",
    gameOpts: { opening: "scandinavian" },
    learn: "Now you’re Black! Answer e4 with d5 right away, take, then bring the queen to a5 safely.",
    play: "Play the Scandinavian in the trainer as Black. Hit the centre from move one.",
    spark: "One opening that works against e4 every single time — no surprises.",
    classic: {
      learn: "1.e4 d5 2.exd5 Qxd5 3.Nc3 Qa5 — the Scandinavian: immediate central challenge as Black, queen tucked on a5.",
      play: "Drill it as Black; learn to develop with tempo after the queen settles.",
      spark: "A dependable, low-theory answer to 1.e4 you can rely on under pressure.",
    },
  },
```

- [ ] **Step 4: Run → pass** (`rtk proxy npx vitest run src/games/chess-quest/content`) — openings + curriculum green.
- [ ] **Step 5: Commit** `feat(chess-quest): Track 3 Opening Range land + lessons; lessons 19/31 play the trainer`.

---

### Task 5: Store trackDone(3) + progress panel + certificate

**Files:**
- Modify: `apps/web/src/games/chess-quest/lib/progress.tsx` (type + `trackDone`)
- Modify: `apps/web/src/games/chess-quest/lib/cert.ts`
- Modify: `apps/web/src/games/chess-quest/lib/__tests__/cert.test.ts`
- Modify: `apps/web/src/games/chess-quest/lib/__tests__/progress.test.ts`
- Modify: `apps/web/src/games/chess-quest/components/quest/ProgressPanel.tsx`
- Modify: `apps/web/src/games/chess-quest/components/quest/Certificate.tsx`

**Interfaces:**
- Produces: `Progress.trackDone(track: 1 | 2 | 3): number`; `certTitle(t1: number, t2: number, t3: number): { title: string; line: string }`.

- [ ] **Step 1: Extend the failing tests.**

progress.test.ts — extend the tracks test:
```ts
    p.setWeekDone(49, true);
    p.setWeekDone(53, true);
    expect(p.trackDone(3)).toBe(2);
```

cert.test.ts — replace/extend for the 3-arg signature:
```ts
import { describe, expect, it } from "vitest";
import { certTitle } from "../cert";

describe("certTitle", () => {
  it("all three tracks → Grandmaster", () => {
    expect(certTitle(24, 24, 5).title).toBe("Chess Quest Grandmaster");
  });
  it("tracks 1+2 done, track 3 partial → Champion", () => {
    expect(certTitle(24, 24, 2).title).toBe("Chess Quest Champion");
  });
  it("track 1 only", () => {
    expect(certTitle(24, 5, 0).title).toBe("First Steps Champion");
  });
  it("track 2 only", () => {
    expect(certTitle(0, 24, 0).title).toBe("Rising Player Champion");
  });
  it("track 3 only → Opening Range Champion", () => {
    expect(certTitle(3, 2, 5).title).toBe("Opening Range Champion");
  });
  it("partial → Adventurer with the day count", () => {
    const r = certTitle(3, 2, 1);
    expect(r.title).toBe("Chess Quest Adventurer");
    expect(r.line).toContain("6 of 53");
  });
});
```

- [ ] **Step 2: Run → fail** (both files).

- [ ] **Step 3a: `progress.tsx`** — widen the type and the impl.

In the `Progress` type: `trackDone(track: 1 | 2 | 3): number;`

In `createProgressState`, replace `trackDone`:
```ts
    trackDone: (track) => {
      const ranges = { 1: [1, 24], 2: [25, 48], 3: [49, 53] } as const;
      const [lo, hi] = ranges[track];
      let n = 0;
      for (let i = lo; i <= hi; i++) if (P().weeks[i]) n++;
      return n;
    },
```

- [ ] **Step 3b: `lib/cert.ts`** — 3-track title:
```ts
export function certTitle(t1: number, t2: number, t3: number): { title: string; line: string } {
  if (t1 === 24 && t2 === 24 && t3 === 5) {
    return {
      title: "Chess Quest Grandmaster",
      line: "has completed the entire Chess Quest — all 53 lessons, from the first square to a real opening repertoire",
    };
  }
  if (t1 === 24 && t2 === 24) {
    return {
      title: "Chess Quest Champion",
      line: "has completed Tracks 1 and 2 — 48 lessons, from the empty board to confident club play",
    };
  }
  if (t1 === 24) {
    return {
      title: "First Steps Champion",
      line: "has completed Track 1 “First Steps” — 24 lessons, from the empty board to full, careful games",
    };
  }
  if (t2 === 24) {
    return {
      title: "Rising Player Champion",
      line: "has completed Track 2 “Rising Player” — 24 lessons of combinations, openings, endgames and strategy",
    };
  }
  if (t3 === 5) {
    return {
      title: "Opening Range Champion",
      line: "has completed Track 3 “Opening Range” — five sound openings played by hand",
    };
  }
  return {
    title: "Chess Quest Adventurer",
    line: `has bravely conquered ${t1 + t2 + t3} of 53 quest days — and the journey continues`,
  };
}
```

- [ ] **Step 3c: `Certificate.tsx`** — pass t3 and update the lands total. Change the `certTitle` call to `certTitle(t1, t2, progress.trackDone(3))` (add `const t3 = progress.trackDone(3);`), and the stats line `of {LANDS.length} lands` already reads live (`LANDS` now length 10) — no other change.

- [ ] **Step 3d: `ProgressPanel.tsx`** — add a Track 3 bar under the two existing ones:
```tsx
        <TrackBar label="Track 3 · Opening Range" done={progress.trackDone(3)} total={5} />
```
(placed right after the Track 2 `TrackBar`).

- [ ] **Step 4: Run → pass** — `rtk proxy npx vitest run src/games/chess-quest/lib`.
- [ ] **Step 5: Commit** `feat(chess-quest): trackDone(3), Track 3 progress bar + 3-track certificate`.

---

### Task 6: Map track-3 header, launcher, arcade card

**Files:**
- Modify: `apps/web/src/games/chess-quest/components/quest/QuestMap.tsx`
- Modify: `apps/web/src/games/chess-quest/components/games/questData.ts` (GAME_LABEL)
- Modify: `apps/web/src/games/chess-quest/index.tsx` (renderGame + arcade list)

**Interfaces:**
- Consumes: `OpeningTrainer` (Task 3), `GameId` `"openingTrainer"` (Task 4).

- [ ] **Step 1: QuestMap track header** — the track-head label currently branches `track === 1 ? "First Steps" : "Rising Player"`. Replace with a map so track 3 shows "Opening Range":

```tsx
                <span className="mk-display text-sm font-bold text-purple-900">
                  {track === 1 ? "First Steps" : track === 2 ? "Rising Player" : "Opening Range"}
                </span>
```

- [ ] **Step 2: GAME_LABEL** — in `components/games/questData.ts` add to `GAME_LABEL`:
```ts
  openingTrainer: "▶ Play the opening",
```
(The `GAME_LABEL` type is `Record<GameId, string>`, so this is required once `openingTrainer` joins `GameId` — TypeScript will error until it's added.)

- [ ] **Step 3: renderGame + arcade** — in `index.tsx`:

Add the import:
```ts
import { OpeningTrainer } from "./components/games/OpeningTrainer";
```
Add the case in `renderGame` (before the closing brace of the switch):
```ts
    case "openingTrainer":
      return <OpeningTrainer opening={(opts.opening as string | undefined) ?? "italian"} />;
```
Add an arcade card to the `ARCADE` array:
```ts
  { id: "openingTrainer", emoji: "📖", title: "Opening Trainer", blurb: "Play a real opening, move by move.", opts: { opening: "italian" } },
```

- [ ] **Step 4: Typecheck + lint** — `rtk proxy npx eslint src/games/chess-quest` (expect only the pre-existing Board shake warning) and `rtk proxy npx tsc --noEmit` is covered by the build in Task 7; here confirm eslint is clean.
- [ ] **Step 5: Commit** `feat(chess-quest): wire Opening Trainer into map header, launcher, arcade`.

---

### Task 7: Verification + e2e + browser demo

**Files:**
- Modify: `apps/web/e2e/games.spec.ts`

- [ ] **Step 1: Add an e2e** — Track 3 lesson launches the trainer and accepts the first move; arcade Opening Trainer opens. Append to `e2e/games.spec.ts`:

```ts
test("an Opening Trainer lesson launches and takes the first move", async ({ page }) => {
  await page.goto("/games/chess-quest");
  await page.evaluate(() => localStorage.removeItem("seazn-games:chess-quest:v1"));
  await page.reload();
  await page.getByRole("button", { name: "Free play" }).click();
  await page.getByRole("button", { name: /Opening Trainer/ }).click();
  await expect(page.getByText(/The Italian Game/)).toBeVisible();
  // First learner move in the Italian: e2–e4.
  await page.locator('[data-square="e2"]').click();
  await page.locator('[data-square="e4"]').click();
  await expect(page.locator('[data-square="e4"]')).toHaveAttribute("aria-label", /white pawn/);
});
```

- [ ] **Step 2: Run e2e** — dev server up on :3000, then `rtk proxy npx playwright test e2e/games.spec.ts --project=parallel --no-deps`. Expected: all pass.

- [ ] **Step 3: Full verification** (from `apps/web`):
```bash
rtk proxy npx vitest run          # all green (incl. openings, curriculum 53/10, cert, stars)
rtk proxy npx eslint src/games    # 0 errors (Board shake warning tolerated)
rtk proxy npm run build           # clean
```

- [ ] **Step 4: Browser demo** — open `/games/chess-quest`, Quest tab: confirm Track 3 "Opening Range" section with days 97–105; open Day 97 → Play → drill the Italian to completion (confetti). Free play: open Opening Trainer, play the line. Screenshot the Track 3 map + the trainer mid-line.

- [ ] **Step 5: Commit** `test(chess-quest): e2e for Opening Trainer` and push the branch.

---

### Self-review notes (addressed)

- Engine legality of every line is the Task 1 gate; the trainer never needs castling.
- `GameId` gains `openingTrainer` in Task 4 before Task 6 references it in `GAME_LABEL`/`renderGame`; `curriculum.test` GAME_IDS updated alongside.
- Lesson counts: 48→53 and lands 9→10 updated in the same task as the data (Task 4) so the shape test never straddles a half-change.
- `trackDone` signature widened (Task 5) before the map/panel/cert consume track 3.
