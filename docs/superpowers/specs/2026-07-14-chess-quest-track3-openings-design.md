# Chess Quest — Track 3 (Opening Range) + Opening Trainer — design

**Date:** 2026-07-14
**Status:** Approved (design review 2026-07-14)
**Worktree/branch:** `worktree-games-track3` (forked from main 5844b32)

## Goal

Add a third quest track of **playable** opening-technique lessons — the learner
*plays* each opening rather than reading about it. Introduces a new
**Opening Trainer** mini-game (follow-the-line drilling), a Track 3 "Opening
Range" land with 5 lessons, and — as a Track 1/2 improvement on the same theme —
converts the two existing instruction-only Italian lessons to launch the trainer.

Also bundled (small, unrelated UI): a "Games" link in the site footer, and the
game-player header (back / title / powered-by) centered.

## Decisions (design review)

| Decision | Choice |
|----------|--------|
| Play mechanic | Follow-the-line trainer: play your side's moves in order; the trainer auto-plays the book replies |
| Openings | Italian, Ruy Lopez, Scotch (all white 1.e4 e5); London (white 1.d4); Scandinavian (black, vs 1.e4) |
| Track shape | New Track 3, one land "Opening Range" (id 10, glyph ♚, `track: 3`), lessons 49–53 = Days 97–105 |
| Engine gap | No castling/en passant in the engine, so every line is 3–5 development plies (the beginner takeaway anyway) — only moves + captures the engine already supports |
| Track 1/2 improvement | Lessons 19 ("Her First Opening") and 31 ("The Italian, With a Plan"), currently `game: null`, launch the Opening Trainer (Italian). Other null-game days left as-is |

## Architecture

### Openings data — `src/games/chess-quest/content/openings.ts` (new)

```ts
export type OpeningMove = { from: string; to: string; san: string };
export type Opening = {
  id: string;            // "italian" | "ruyLopez" | "scotch" | "london" | "scandinavian"
  name: string;
  learnerSide: "white" | "black";
  line: OpeningMove[];   // full sequence, both sides, in play order
  idea: string;          // one-line "why" shown under the board
};
export const OPENINGS: Record<string, Opening>;
```

The five lines (squares are engine indices via `sqIdx` at load; `san` is copy):

1. **italian** (white): e2e4, e7e5, g1f3, b8c6, f1c4, f8c5
2. **ruyLopez** (white): e2e4, e7e5, g1f3, b8c6, f1b5, a7a6
3. **scotch** (white): e2e4, e7e5, g1f3, b8c6, d2d4, e5d4, f3d4
4. **london** (white): d2d4, d7d5, g1f3, g8f6, c1f4
5. **scandinavian** (black): e2e4, d7d5, e4d5, d8d5, b1c3, d5a5

Every `to` for a learner move must be a legal `applyMove` result on the running
board (verified by tests — see below); replies are auto-applied likewise.

### Opening Trainer game — `src/games/chess-quest/components/games/OpeningTrainer.tsx` (new)

Props: `{ opening: string }`. Uses `Board`, `GameShell`, engine
(`legalTargets`/`applyMove`/`sqIdx`/`parseFEN` START), `celebrate`, `voice`,
`useProgress`, `useLater`, `STAR_RULES.openingTrainer`.

Flow (port of the app's tap-move idiom):
- Start from the standard position. Maintain `ply` (index into `line`).
- If `line[ply]` is an opponent move (side ≠ learnerSide), auto-play it after a
  short `later()` delay, highlight it, advance `ply`. For a black-learner
  opening this plays white's 1.e4 first.
- On the learner's turn: highlight the from-square (a gentle hint), accept a
  tap-tap move. If it equals `line[ply]` → apply, `sfx.move`, advance, then
  trigger the next opponent reply. If wrong → `sfx.bad`, shake, coach nudge
  ("Not the book move — try the highlighted piece"), reset the attempt (board
  stays; count a mistake).
- When `ply` reaches the end → `celebrate()`, `voice.say(name + " — you played the whole line!")`, award `STAR_RULES.openingTrainer(mistakes)`, show "Play again".
- HUD: `{name}` + `move {learnerMovesDone}/{learnerMovesTotal}`. The opening's
  `idea` shows under the board.

`STAR_RULES.openingTrainer(mistakes)`: 0 → 3, 1–2 → 2, else 1. (Add to
`lib/stars.ts` with tests.)

### Content — lands + lessons

- `content/lands.ts`: add land id 10 `{ glyph: "♚", name: "Opening Range", weeks: [49, 53], track: 3, goal, check, checkClassic }`.
- `content/lessons.ts`: add `GameId` member `"openingTrainer"`; add lessons 49–53
  (land 10), each `game: "openingTrainer"`, `gameOpts: { opening: <id> }`, with
  brief Learn/Play/Tip (Story + Classic) that point at *playing* the line.
  - 49 Italian, 50 Ruy Lopez, 51 Scotch, 52 London, 53 Scandinavian.
- **Improvement:** lessons 19 and 31 change `game: null` → `game: "openingTrainer"`,
  `gameOpts: { opening: "italian" }`. Their existing copy stays (already about
  the Italian); the Play button now drills it.

### Store, map, progress, certificate

- `lib/progress.ts` `trackDone(track: 1 | 2 | 3)`: track 3 → lessons 49–53 (lo 49, hi 53). Type widened.
- `QuestMap`: Track 3 header renders "Opening Range" eyebrow — the generic
  track-head logic already keys off `land.track`; extend the label map to
  include `3 → "Opening Range"`.
- `QuestHeader` / progress bar: already computes over `LESSONS.length` (now 53) — no change beyond data.
- `ProgressPanel`: add a Track 3 bar (`trackDone(3)` / 5).
- `Certificate` / `lib/cert.ts` `certTitle(t1, t2, t3)`: widen signature.
  - t1===24 && t2===24 && t3===5 → "Chess Quest Grandmaster" (line: entire quest incl. an opening repertoire)
  - else fall through to the existing t1/t2 tiers; t3-only (t3===5, others partial) → "Opening Range Champion".
  - `Certificate` passes `progress.trackDone(3)`; stats line adds lands done/10.

### Games registry / launcher

- `index.tsx` `renderGame`: add `case "openingTrainer": return <OpeningTrainer opening={opts.opening as string ?? "italian"} />`.
- `GAME_LABEL` (questData): add `openingTrainer: "▶ Play the opening"`.
- Free-play arcade: add an "Opening Trainer" card (defaults to Italian) so it's
  reachable outside the quest, consistent with the other 8.

## Testing

- **Vitest — openings content verification** (new `content/__tests__/openings.test.ts`):
  for each opening, replaying `line` from the start position with `applyMove` keeps
  every move legal (`legalTargets` contains each `to`), sides alternate correctly,
  and `learnerSide` matches who moves first among the learner's plies. This is the
  machine guard that the lines are playable — same rigor as the puzzle packs.
- **Vitest — stars:** `openingTrainer` thresholds (0→3, 1→2, 2→2, 3→1).
- **Vitest — curriculum shape** (update existing): 53 lessons, 10 lands, track 3
  lands cover 49–53, `openingTrainer` added to the valid `GameId` set, lands tile
  1–53 exactly once, lessons 19 & 31 now have a real game id.
- **Vitest — cert:** `certTitle` 3-track branches.
- **Playwright:** a lesson in Track 3 launches the trainer and the first move is
  accepted; arcade Opening Trainer plays the Italian line to completion.

## Out of scope

- Castling / en passant in the engine (lines stop before castling by design).
- Deeper opening theory, transpositions, or move-order alternatives (single
  mainline per opening; wrong moves just retry).
- The footer link + header centering are trivial UI bundled in this branch, not
  part of the quest feature.
