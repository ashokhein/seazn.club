# Seazn Games — Phase C (Board + Mini-Games, Chess Quest Goes Live) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Interactive Board + all 8 mini-games as React components with a free-play hub; flip Chess Quest's registry status to `live` so `/games/chess-quest` is playable.

**Architecture:** Client components under `src/games/chess-quest/components/`, consuming the Phase B engine barrel and content. Shared infrastructure first (GameShell with coach bubble, timer registry hook, in-memory progress context whose API Phase D swaps for localStorage, copy-register context), then one component per mini-game porting the original mechanics 1:1 from `~/GitHub/chess-quest/js/games.js` (the normative reference — line refs per task), re-skinned Seazn (Tailwind + one scoped `chess-quest.css` for board grid/animations).

**Tech Stack:** React 19 client components, Tailwind v4 + scoped CSS, Vitest for pure logic, Playwright for flows. No DB, no localStorage yet (Phase D).

**Spec:** `docs/superpowers/specs/2026-07-14-seazn-games-chess-quest-design.md` (Phase C). Branch `games-platform` (PR #92).

## Global Constraints

- All new files under `apps/web/src/games/chess-quest/` except e2e; every component file starts with `"use client"`.
- Engine imports ONLY from `../engine` barrel; content from `../content/*`.
- **Mechanics are ports, not redesigns.** Normative source: `~/GitHub/chess-quest/js/games.js` (read the referenced lines before implementing each game). Keep: star formulas, coach dialogue flows, timing delays (250/500/750/900/1300/1400/1600 ms), tap-tap move selection, board-reset-on-wrong-answer behavior. Copy strings carried verbatim (both registers via `t(story, classic)`).
- Known source quirk to fix while porting: mateInOne completion text hardcodes "All 12 checkmates" but MATE1 has 18 puzzles — use `MATE1.length` in copy.
- **SFX/FX deferred to Phase E:** `lib/sfx.ts` ships as a typed no-op object (`tap/good/bad/move/coin/fanfare`) so call sites are wired now; confetti `FX.burst` is replaced by the piece `pop` animation + ★ text until E.
- **Progress is session-only in C:** `ProgressProvider` holds Store-shaped state in React state. Phase D swaps the provider internals for localStorage profiles; the consumer API below is the contract — don't deviate from it.
- Copy register: default `"classic"` (public site, adult visitor); Story strings still ported and reachable via the register toggle Phase D adds. `t(story, classic)` picks by register; `isStory()` gates the italic story leads in hunts/tactics.
- Coach/status copy may contain `<strong>`/`<em>` — render via a `Rich` helper using `dangerouslySetInnerHTML` on our own literal strings only (never user input).
- Timers: every delayed callback goes through `useLater()` (auto-cleared on unmount and via `clearPending()` on game switch) — the original's stale-timer bug class stays dead.
- Board colors: Seazn palette — light squares `bg-purple-50`, dark `bg-purple-200`, selection/move/capture/hint tints in `chess-quest.css` with `cq-` prefixed classes; pieces are the filled glyphs `♟♞♝♜♛♚` colored white/slate like the original's w/b classes.
- Tests: pure logic in `lib/*.ts` gets vitest coverage (star formulas, generators, progress store); interactive flows get Playwright e2e; browser-verify each game during its task (dev server + click through once).
- Conventional commits with the `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` trailer; run suites with `rtk proxy npx vitest run …`.

---

### Task C1: Shared foundations — sfx stub, timers, progress store, copy register

**Files:**
- Create: `apps/web/src/games/chess-quest/lib/sfx.ts`
- Create: `apps/web/src/games/chess-quest/lib/use-later.ts`
- Create: `apps/web/src/games/chess-quest/lib/progress.tsx`
- Create: `apps/web/src/games/chess-quest/lib/copy.tsx`
- Create: `apps/web/src/games/chess-quest/lib/stars.ts`
- Test: `apps/web/src/games/chess-quest/lib/__tests__/stars.test.ts`
- Test: `apps/web/src/games/chess-quest/lib/__tests__/progress.test.ts`

**Interfaces (the Phase D contract — later tasks and Phase D consume exactly this):**

```ts
// sfx.ts — no-op until Phase E
export const sfx: { tap(): void; good(): void; bad(): void; move(): void; coin(): void; fanfare(): void };

// use-later.ts
export function useLater(): { later(fn: () => void, ms: number): void; clearPending(): void };
// clearPending also runs automatically on unmount.

// progress.tsx  (context provider + hook; in-memory in Phase C)
export type Progress = {
  isSolved(i: number): boolean; setSolved(i: number): void; solvedCount(): number; resetPuzzles(): void;
  isSolved2(i: number): boolean; setSolved2(i: number): void; solved2Count(): number; resetPuzzles2(): void;
  isHuntSolved(i: number): boolean; setHuntSolved(i: number): void; huntCount(): number; resetHunts(): void;
  isTacticSolved(pack: string, i: number): boolean; setTacticSolved(pack: string, i: number): void;
  tacticCount(pack: string): number; resetTactics(pack: string): void;
  setGameStars(gameId: string, stars: number): void; // keep-max semantics
  gameStars(gameId: string): number;
  setBest(gameId: string, score: number): boolean; // true = new record
  getBest(gameId: string): number;
};
export function ProgressProvider({ children }: { children: React.ReactNode }): JSX.Element;
export function useProgress(): Progress;

// copy.tsx
export type Register = "story" | "classic";
export function CopyProvider({ register = "classic", children }): JSX.Element;
export function useCopy(): { t(story: string, classic: string): string; isStory(): boolean };

// stars.ts — every star formula, pure (ported from js/games.js; tested)
export const STAR_RULES: {
  squareRace(score: number): number;             // ≥12→3, ≥7→2, ≥3→1, else 0
  coinHop(moves: number, piece: string): number; // easy (R/B/Q): ≤9→3, ≤13→2, else 1; hard (N/K/P): ≤14→3, ≤20→2, else 1
  pawnWars(whiteWon: boolean): number;           // 3 / 1
  packStars(solved: number): number;             // mateInOne, mateInTwo, tier-2 tactics: ≥12→3, ≥8→2, ≥4→1, else 0
  hangingHunt(solved: number): number;           // ≥8→3, ≥5→2, ≥3→1, else 0
  tacticTier1(total: number): number;            // across fork+pin+skewer+disco (13 cases): ≥13→3, ≥8→2, ≥4→1, else 0
  rookMaze(moves: number, par: number): number;  // ≤par→3, ≤par+1→2, else 1
};
```

- [ ] **Step 1: Write failing tests** — `stars.test.ts` asserts every threshold above at its boundary values (e.g. `squareRace(12)===3`, `squareRace(11)===2`, `coinHop(9,"Q")===3`, `coinHop(10,"Q")===2`, `coinHop(14,"N")===3`, `rookMaze(5,5)===3`, `rookMaze(6,5)===2`, `rookMaze(7,5)===1`, `packStars(11)===2`, `tacticTier1(13)===3`). `progress.test.ts` exercises the Progress object created by the provider's internal factory (export `createProgressState()` for testability): solve/count/reset per pack family, keep-max `setGameStars`, `setBest` returns true only on strict improvement.
- [ ] **Step 2: Run to verify failure** — `rtk proxy npx vitest run src/games/chess-quest/lib` → cannot resolve modules.
- [ ] **Step 3: Implement all five modules** per the interfaces (progress state: plain objects `{ solved: Set<number>, solved2: Set<number>, hunts: Set<number>, tactics: Record<string, Set<number>>, stars: Record<string, number>, bests: Record<string, number> }` behind `useState` + stable callbacks).
- [ ] **Step 4: Run to verify pass**, then commit `feat(chess-quest): shared game foundations — progress, copy, timers, star rules`.

---

### Task C2: Board component + game chrome

**Files:**
- Create: `apps/web/src/games/chess-quest/components/Board.tsx`
- Create: `apps/web/src/games/chess-quest/components/GameShell.tsx`
- Create: `apps/web/src/games/chess-quest/components/rich.tsx`
- Create: `apps/web/src/games/chess-quest/chess-quest.css`

**Interfaces:**

```tsx
// Board.tsx — controlled, tap-driven (port of js/board.js)
export const GLYPH: Record<string, string>; // { P:"♟", N:"♞", B:"♝", R:"♜", Q:"♛", K:"♚" }
export type Highlight = "sel" | "move" | "cap" | "hint";
export function Board(props: {
  position: string[];                       // 64-array, engine convention
  highlights?: Partial<Record<number, Highlight>>;
  coins?: ReadonlySet<number>;              // rendered on empty squares
  labels?: boolean;                         // file letters on rank 1, rank numbers on a-file
  onTap?(idx: number): void;
  popToken?: { idx: number; n: number } | null; // n change triggers pop animation on idx
  shakeToken?: number;                      // change triggers board shake
}): JSX.Element;
// Each square renders as a <button> with data-square="e4" and
// aria-label "e4" (+ piece name when occupied) — e2e and a11y hook.

// GameShell.tsx — replaces the modal: header (title + score), coach bubble
// (status rich text + chip buttons), extra slot (dots/pickers), board slot, controls slot.
export function GameShell(props: {
  title: string;
  score?: React.ReactNode;
  status: string;                            // rich HTML string (own literals only)
  chips?: { label: string; onPick(): void }[];
  extra?: React.ReactNode;
  controls?: React.ReactNode;
  children: React.ReactNode;                 // the board
}): JSX.Element;

// rich.tsx
export function Rich({ html, className }: { html: string; className?: string }): JSX.Element;
```

- `chess-quest.css`: `.cq-board` 8×8 grid (aspect-square, max 480px), square colors, `.cq-hl-sel/-move/-cap/-hint` tints, `.cq-coin` dot, `@keyframes cq-pop` (scale 1.35→1, 300ms) and `cq-shake` (translate ±4px, 300ms), rank/file label pseudo-elements. Import once from the hub root.
- Coach bubble: ♞ face + purple-tinted bubble, chips as small rounded buttons — Seazn styling of the original coach-row.
- [ ] **Step 1: Implement** all four files (no unit tests — node-env vitest can't render; verified in browser next step and by every game task after).
- [ ] **Step 2: Browser-verify** with a temporary render: point `player-map.tsx`'s placeholder at a scratch page that mounts `<Board position={parseFEN(START).board} labels />` inside `GameShell` — confirm grid, glyphs, labels, tap logging, pop/shake animations in the dev server, then revert the scratch wiring.
- [ ] **Step 3: Commit** `feat(chess-quest): Board component + GameShell chrome`.

---

### Task C3: Square Race + Coin Hop

**Files:**
- Create: `apps/web/src/games/chess-quest/components/games/SquareRace.tsx` (source: games.js:136–195)
- Create: `apps/web/src/games/chess-quest/components/games/CoinHop.tsx` (source: games.js:197–286)
- Create: `apps/web/src/games/chess-quest/lib/rand.ts` — `randSquares(n, exclude, allowed?)` port (games.js:122–134) + test in `lib/__tests__/rand.test.ts` (count, exclusion, allowed-filter honored, no duplicates).

**Behavior contracts (port exactly):**
- SquareRace: empty board, labels on; Start → 60s countdown (interval, cleared on unmount), random target square announced as `Find <strong>e4</strong>!`; correct tap: score++, brief hint flash 250ms, new target; wrong: shake. Finish: stars via `STAR_RULES.squareRace`, `setBest("squareRace", score)` record flag in copy, `setGameStars`, Play-again button. HUD `⭐ n · ⏱ ts`.
- CoinHop: `pieces` prop (default `["N"]`), chip picker when >1 (games.js drawPicker); piece placed `27 + rand(10)`; 6 coins via `randSquares`, bishop restricted to same-color squares; tap piece → show `pieceTargets` (pseudo-legal — intentional, no kings here); move: coins collected shrink set, pawn never promotes in this game (re-set "P"), moves++; all collected → stars via `STAR_RULES.coinHop(moves, piece)`. HUD `🪙 left · 👣 moves`. "New coins" control.
- [ ] **Step 1: rand.ts + failing test, run, implement, pass.**
- [ ] **Step 2: Implement both game components.**
- [ ] **Step 3: Browser-verify each** (temporary hub wiring acceptable — Task C7 makes it permanent): play one Square Race round ≥3 score, one full Coin Hop clear.
- [ ] **Step 4: Commit** `feat(chess-quest): Square Race + Coin Hop mini-games`.

---

### Task C4: Pawn Wars + shared mate-miss coach

**Files:**
- Create: `apps/web/src/games/chess-quest/components/games/PawnWars.tsx` (source: games.js:288–384)
- Create: `apps/web/src/games/chess-quest/lib/mate-miss.ts` (source: games.js:386–429) — returns the coach interaction plan for a non-mating attempt: given `next` board, produces one of three flows (`no-check` chips / `escape` tap-the-square with 2-miss fallback / `capture-block` plain reset) as data the game component renders via GameShell chips/tap handler. Test `lib/__tests__/mate-miss.test.ts`: classify each flow from three fixture boards (no-check move, check-with-escape incl. escape list, check-stuck-but-capturable).

**Behavior contracts:**
- PawnWars: 8 white pawns rank 2 vs 8 black rank 7, hot-seat (white = "Kid"/"White" per register, black = "Grown-up"/"Black"); tap-select shows legal targets (`hl-move`/`hl-cap`); win on promotion (board piece becomes Q/q) or opponent stuck (`allLegalMoves` empty → mover of last move wins); stars 3/1 via `STAR_RULES.pawnWars`; hanging-pawn coach interjection after a white move that leaves the moved pawn attacked and undefended — chips "Oops! Take back" (restores snapshot only if board unchanged) / "It's my plan 😏" (verbatim flows, games.js:355–374).
- [ ] **Step 1: mate-miss failing test → implement → pass.**
- [ ] **Step 2: Implement PawnWars, browser-verify** one game incl. triggering the take-back coach.
- [ ] **Step 3: Commit** `feat(chess-quest): Pawn Wars + shared mate-miss coach`.

---

### Task C5: Mate in 1 + Mate in 2

**Files:**
- Create: `apps/web/src/games/chess-quest/components/games/MateInOne.tsx` (source: games.js:431–538)
- Create: `apps/web/src/games/chess-quest/components/games/MateInTwo.tsx` (source: games.js:540–706)
- Create: `apps/web/src/games/chess-quest/components/games/PuzzleDots.tsx` — shared numbered dot-row (solved/current states, aria-labels), used by both + hunts + tactics.

**Behavior contracts:**
- MateInOne: MATE1 pack; auto-advance to first unsolved (all solved → index 0); dots navigation; Hint highlights solution's from-square + shows `pz.hint`; correct = any legal move where `isMate(next,false)` (accepts alternates); wrong → `mate-miss` flow with board reset to puzzle FEN and `(The Hint button is your friend!)` nudge after 2 tries; solved: `setSolved`, pack stars `packStars(solvedCount)`, 1400ms then next unsolved; completion copy uses `MATE1.length` (18 — fixes source's hardcoded "12"). "Start pack over" resets.
- MateInTwo: MATE2 pack, two phases. Phase 1: immediate mate accepted ("even faster than asked"); `isMateIn2After` accepted → status "That's the squeeze…", 750ms → `bestDefense` reply animates, phase 2 ("Black tries e7–e8… now finish it. Mate in one!"); wrong phase-1 move → diagnostic: find black's saving reply (first reply after which `hasMateIn1` false), 900ms reset with check/no-check-specific coaching (games.js:659–679 verbatim). Phase 2: must mate, else `mate-miss` against `midBoard`. Hint: phase 1 = solution from-square + hint text; phase 2 = from-square of an actual mating move found by search. Solved flow like MateInOne (1600ms, 12 puzzles, `packStars`).
- [ ] **Step 1: Implement PuzzleDots + MateInOne, browser-verify** (solve puzzle 1: e1→e8; then a deliberate wrong move → coach flow).
- [ ] **Step 2: Implement MateInTwo, browser-verify** (solve ladder puzzle 1: b5→b7, watch black defense, finish mate; and one wrong-move diagnostic).
- [ ] **Step 3: Commit** `feat(chess-quest): Mate in 1 + Mate in 2 puzzle games`.

---

### Task C6: Piece Detective + Trick Shots

**Files:**
- Create: `apps/web/src/games/chess-quest/components/games/HangingHunt.tsx` (source: games.js:810–926)
- Create: `apps/web/src/games/chess-quest/components/games/TacticTrainer.tsx` (source: games.js:928–1092)

**Behavior contracts:**
- HangingHunt: HUNTS cases; story lead (italic) only when `isStory()`; tap the hanging piece = solved (hint flash, 1300ms advance, `STAR_RULES.hangingHunt`); wrong taps get targeted coaching: empty/white square → "tap a black piece"; king → "kings can never be taken"; unattacked → "is anything even attacking…"; attacked-but-defended → tap-the-guard interaction using `defendersOf` (games.js:905–919). Hint lights white attackers of the answer square.
- TacticTrainer: `pack` prop; **plus a pack chip picker** (all 8 packs, current highlighted — free-play addition, same chip pattern as CoinHop's piece picker) since the hub has no curriculum context; PACK_INFO names/asks verbatim (games.js:929–938); solve = any legal white move passing the pack's detector on the landing square; fork-specific miss coaching (unsafe square → tap-the-eater; safe but <2 targets → count chips), pin/skewer/disco one-line resets (games.js:1048–1081); stars: tier-1 total across 4 packs via `tacticTier1`, tier-2 via `packStars` stored under `tacticTrainer2`.
- [ ] **Step 1: Implement HangingHunt, browser-verify** (solve case 1 d7; trigger guard-tap coaching on a defended piece).
- [ ] **Step 2: Implement TacticTrainer, browser-verify** (fork 1 b5→c7 solve; one wrong fork square → counting chips; switch pack via chips).
- [ ] **Step 3: Commit** `feat(chess-quest): Piece Detective + Trick Shots trainers`.

---

### Task C7: Hub, go-live flip, e2e

**Files:**
- Modify: `apps/web/src/games/chess-quest/index.tsx` — placeholder becomes the hub: providers (`ProgressProvider`, `CopyProvider`), css import, game picker grid (8 cards: emoji, title, one-liner), selected game renders full-area with "← All games" back within the hub; game defaults `coinHop {pieces:["N","B","R","Q","K"]}`, `rookMaze {pieces:["R","B","Q"]}`, `tacticTrainer {pack:"fork"}`.
- Create: `apps/web/src/games/chess-quest/components/games/RookMaze.tsx` (source: games.js:708–808 — slotted here to keep C6 balanced): generator loop (piece on ranks 1–2, 9 wall pawns, target with `pathDistances ≥ 3` pre-prey and `≥ 2` post-prey else regenerate, 60 attempts), par display, `pieceTargets` movement, blocked-tap coaching line, `STAR_RULES.rookMaze`.
- Modify: `apps/web/src/games/registry.ts` — chess-quest `status: "live"`.
- Modify: `apps/web/e2e/games.spec.ts` — replace coming-soon expectations: listing card shows "Play →"; `/games/chess-quest` shows hub with 8 game cards; deterministic play-through: open "Mate in 1", tap e1 then e8, expect "Checkmate!"; subdomain test now expects the hub.
- [ ] **Step 1: RookMaze + hub implementation.**
- [ ] **Step 2: Flip registry to live** — sitemap gains `/games/chess-quest` automatically (assert via curl).
- [ ] **Step 3: Update + run e2e:** `rtk proxy npx playwright test e2e/games.spec.ts --project=parallel --no-deps` → all pass.
- [ ] **Step 4: Commit** `feat(chess-quest): free-play hub + Rook Maze; chess quest goes live`.

---

### Task C8: Full verification + demo

- [ ] **Step 1:** `rtk proxy npx vitest run` (all green), `rtk proxy npx eslint src/games` (exit 0), `rtk proxy npm run build` (clean, routes emitted).
- [ ] **Step 2: Browser demo pass:** every one of the 8 games opened and one interaction each on `/games/chess-quest`; screenshot hub + one game.
- [ ] **Step 3: Push** (PR #92 or successor per finishing-a-development-branch).

---

### Out of scope (Phase D/E)

- localStorage persistence, profiles, register toggle UI (D — swaps `ProgressProvider`/`CopyProvider` internals only).
- QuestMap/lesson launching with curriculum `gameOpts` (D).
- Real sounds, voice, confetti (E).
