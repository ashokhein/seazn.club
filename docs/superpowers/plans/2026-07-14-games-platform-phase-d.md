# Seazn Games — Phase D (Quest Map, Profiles, Progress, Certificate) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the free-play arcade into the full Chess Quest journey — a 48-lesson map over 9 lands (Day 1→95) that launches each lesson's mini-game, backed by localStorage profiles with streaks, a progress panel, and a printable certificate.

**Architecture:** Rewrite the in-memory `lib/progress` into a localStorage-backed **profiles store** (the Phase C `Progress` API is preserved and extended). New components under `components/quest/`: `QuestMap`, `LessonCard`, `QuestHeader`, `ProfilePanel`, `ProgressPanel`, `Certificate`, `GrownUpsDrawer`. The hub landing becomes the quest; the 8-game arcade stays reachable as "Free play". Lessons launch the existing Phase C game components with their `gameOpts`.

**Tech Stack:** React 19 client components, Tailwind v4 + the existing `chess-quest.css`, Vitest (localStorage shim for the store, like the original `store.test.mjs`), Playwright.

**Spec:** `docs/superpowers/specs/2026-07-14-seazn-games-chess-quest-design.md` (Phase D). Branch `games-platform` (PR #92). Normative source for behavior/copy: `~/GitHub/chess-quest/js/{store,app}.js` and `css/style.css` (read the referenced lines per task).

## Global Constraints

- All new code under `apps/web/src/games/chess-quest/`; every component file starts with `"use client"`. Engine from `../engine`, content from `../content/*`.
- **localStorage key `seazn-games:chess-quest:v1`** (namespaced; **no migration** from the standalone app's `chess-quest-v2` — different origin, fresh start per spec).
- **The Phase C `Progress` API stays byte-compatible** — all 8 game components already call `isSolved/setGameStars/setBest/...`. Phase D only *adds* methods (weeks, activity/streak, name/mode, profiles, totalStars) and swaps the provider's internals for persistence. Do not rename or change existing signatures.
- **SSR safety:** the whole chess-quest tree already loads via `next/dynamic({ ssr: false })` (player-map), but still guard every `localStorage`/`window` access with `typeof window !== "undefined"`, and hydrate the store in an effect after mount so first render is deterministic.
- Copy register comes from the **active profile's mode** (`story`/`classic`), not a static prop — `CopyProvider` reads it from the store. Default new profiles to `classic` on the public site.
- Lessons run every other day: `dayOf(n) = 2*n - 1` (Day 1, 3, 5…). Streak: activity-date chain alive while gaps ≤ 2 days.
- Rich copy (`<strong>`, `<em>`, lesson HTML from content) renders via the existing `Rich` helper — our own literal/content strings only.
- Star/best/solved semantics unchanged from Phase C (keep-max stars, strict-improvement best).
- Run suites with `rtk proxy npx vitest run …`. Conventional commits, `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task D1: Persistent profiles store

**Files:**
- Rewrite: `apps/web/src/games/chess-quest/lib/progress.tsx`
- Test: `apps/web/src/games/chess-quest/lib/__tests__/progress.test.ts` (extend)

**Interfaces (extends the Phase C `Progress` — additions only):**

```ts
// Existing (unchanged, still consumed by the 8 games):
//   isSolved/setSolved/solvedCount/resetPuzzles, ...Solved2..., ...Hunt...,
//   isTacticSolved/setTacticSolved/tacticCount/resetTactics,
//   setGameStars/gameStars, setBest/getBest

export type Progress = {
  /* …all Phase C members unchanged… */

  // lessons
  isWeekDone(n: number): boolean;
  setWeekDone(n: number, done: boolean): void;
  weeksDone(): number;
  currentWeek(total: number): number;          // highest done + 1, clamped
  landDone(land: { weeks: [number, number] }): boolean;
  trackDone(track: 1 | 2): number;             // lessons done in that track's 24

  // activity / streak
  markActivity(dateISO?: string): void;
  activityDates(): string[];
  streak(todayISO?: string): number;           // gaps ≤ 2 days keep it alive

  // identity + register
  getName(): string;
  setName(n: string): void;
  getMode(): "story" | "classic";
  setMode(m: "story" | "classic"): void;
  totalStars(): number;                        // weeksDone + Σ game stars

  // profiles
  profiles(): { id: string; name: string; mode: "story" | "classic" }[];
  activeId(): string;
  addProfile(name: string, mode: "story" | "classic"): string;  // switches to it
  switchProfile(id: string): boolean;
  removeProfile(id: string): boolean;          // refuses to remove the last one
};

// Testable factory (no React) — persists through an injected storage.
export function createProgressState(storage?: Storage): Progress;
export function ProgressProvider(props): JSX.Element;   // loads/saves localStorage
export function useProgress(): Progress;
```

- Persistence model (port `store.js`): one blob `{ active, seq, profiles: { [id]: Profile } }`; `Profile = { name, mode, weeks:{}, stars:{}, best:{}, solved:[], solved2:[], hunts:[], tactics:{}, activity:[], created }`. Every mutation calls a private `save()` (writes JSON, guarded try/catch for private mode). `touch()` adds today to activity on any real play (setWeekDone(true), setGameStars, setBest, setSolved*, setHuntSolved, setTacticSolved) — matches source.
- Corrupt/unparseable blob → discard, start one blank profile (console.warn, no Sentry).
- `ProgressProvider`: `createProgressState()` bound to `window.localStorage` after mount; version-bump on mutation (Phase C pattern) so consumers re-render. Before hydration (SSR/first paint) render children against a fresh in-memory state; swap to the persisted one in a mount effect.

- [ ] **Step 1: Extend the failing test** — add, alongside the Phase C cases, a localStorage-shim suite porting `store.test.mjs` intent (no v1 migration): default single profile, add/switch/isolation/remove (refuses last), `setMode` on active only + never touches other profiles, weeks done/current/landDone/trackDone, activity dedupe + streak (`streak("2026-07-12")===3` for a ≤2-gap chain; alive 2 days after; dead after 3), `totalStars`, persistence across a fresh `createProgressState(sameStorage)` reload. Use a `Map`-backed fake `Storage`.
- [ ] **Step 2: Run → fail** (`rtk proxy npx vitest run src/games/chess-quest/lib/__tests__/progress.test.ts`).
- [ ] **Step 3: Implement** the profiles store + provider.
- [ ] **Step 4: Run → pass**; also rerun the 8-game lib deps quickly (nothing else imports progress internals).
- [ ] **Step 5: Commit** `feat(chess-quest): localStorage profiles store — lessons, streak, identity`.

---

### Task D2: Copy register from store + Quest header

**Files:**
- Modify: `apps/web/src/games/chess-quest/lib/copy.tsx` (register from a prop the hub feeds from `getMode()`, still overridable)
- Create: `apps/web/src/games/chess-quest/components/quest/QuestHeader.tsx`

**Interfaces:**
- `QuestHeader` (port `renderHeader`, app.js:45–75): title (`{name}'s Chess Quest ♞`), a Players button (name + Story/Classic tag) that opens the profile panel (callback prop), a Progress button (callback), `⭐ {totalStars}`, `{weeksDone} / 48 days` with a fill bar, and the 9 land badges (glyph, `badge-won` when `landDone`). Taglines/footlines by register (verbatim).
- `CopyProvider` gains no new API surface for games; the hub passes `register={progress.getMode()}` so switching a profile re-renders copy.

- [ ] **Step 1: Implement** `QuestHeader` (Tailwind, Seazn palette; reuse `Rich` where copy has markup). No unit test (visual) — verified in D7.
- [ ] **Step 2: Commit** `feat(chess-quest): quest header HUD + register wired to active profile`.

---

### Task D3: Quest map + lesson card

**Files:**
- Create: `apps/web/src/games/chess-quest/components/quest/QuestMap.tsx` (port `renderMap`, app.js:78–126)
- Create: `apps/web/src/games/chess-quest/components/quest/LessonCard.tsx` (port `renderCard`, app.js:129–187)

**Behavior contracts:**
- `QuestMap`: Track 1/Track 2 headers ("First Steps" / "Rising Player"); per land a header (glyph, `Days {dayOf(lo)}–{dayOf(hi)}`, name, medal when `landDone`); stops for each lesson showing `✓` when done, a ♞ pony on the current stop (`currentWeek`, not done), else the day number; selected stop highlighted. Tapping a stop selects it (calls `onSelect(n)`).
- `LessonCard`: for the selected lesson, render eyebrow (`{glyph} {land} · Day {dayOf(n)}`), title, Learn/Play/`Spark`|`Tip` rows (copy via `useCopy().t`, classic block when present), optional **diagram mini-board** (`<Board>` small, non-interactive, from `diagram.fen`, highlighting `diagram.from` + its `pieceTargets` when present), a **Play button** that launches the lesson's game (`gameOpts`) via an `onPlay(game, gameOpts)` prop, a **Mark-day-done** toggle (`setWeekDone`), and on the land's last lesson a "Level-up check" line (`land.check`/`checkClassic`). `GAME_LABEL` map (port app.js — e.g. squareRace → "Play Square Race", tacticTrainer → "Play Trick Shots", null game → no button).
- [ ] **Step 1: Implement** `GAME_LABEL` + both components.
- [ ] **Step 2: Browser-verify** in D7 (needs the hub wiring). No unit test.
- [ ] **Step 3: Commit** `feat(chess-quest): quest map + lesson card`.

---

### Task D4: Profile panel + grown-ups drawer

**Files:**
- Create: `apps/web/src/games/chess-quest/components/quest/ProfilePanel.tsx` (port `renderProfilePanel`, app.js ~246–320)
- Create: `apps/web/src/games/chess-quest/components/quest/GrownUpsDrawer.tsx` (port `renderGrownUps`, app.js:190–206)

**Behavior contracts:**
- `ProfilePanel` (modal): list profiles (name or "Player N", mode tag, active marker), Switch/Delete per row (Delete two-step "armed" confirm; refuses when only one remains), an add form (name input max 16 chars + Story/Classic choice → `addProfile`), a Story/Classic toggle for the active profile (`setMode`), and a name field (`setName`). Each write re-renders the hub (provider version bump). Hint line "Each player keeps their own progress, stars and streak."
- `GrownUpsDrawer`: a `<details>` disclosure; content from `content/grown-ups.ts` (`GROWN_UPS`/`GROWN_UPS_CLASSIC` by register) — recipe steps, rules, toolbox, stuck — with the register-varied headings (verbatim).
- [ ] **Step 1: Implement** both.
- [ ] **Step 2: Commit** `feat(chess-quest): profile panel + grown-ups drawer`.

---

### Task D5: Progress panel

**Files:**
- Create: `apps/web/src/games/chess-quest/components/quest/ProgressPanel.tsx` (port `renderProgressPanel` + `last14Days`, app.js:357–441)

**Behavior contract:** modal showing — stat tiles (day streak, `⭐ totalStars`, total puzzles solved = `solvedCount+solved2Count+huntCount+tacticTier1+tacticTier2`, days played); two track bars (Track 1 / Track 2, x/24); a 14-day dot strip (`last14Days`, filled where an activity date matches, weekday letters); a games table (9 rows: the 8 games + Trick Shots-Master, each with `starsGlyph(gameStars)` ★/☆ out of 3 and a detail cell — e.g. Mate in 1 `{solvedCount} / {MATE1.length}`, Trick Shots `{t1} / 13`, Square Race best). A "🖨 Print certificate" button (calls into D6). Content constants (MATE1/MATE2/HUNTS lengths) from `content/puzzles`.
- [ ] **Step 1: Implement** `ProgressPanel` (+ a small pure `last14Days(todayISO?)` helper in `lib/` with a unit test: returns 14 entries, correct `on` flags for supplied activity dates).
- [ ] **Step 2: Run the helper test → pass.**
- [ ] **Step 3: Commit** `feat(chess-quest): progress panel with streak, tracks, 14-day strip`.

---

### Task D6: Printable certificate

**Files:**
- Create: `apps/web/src/games/chess-quest/components/quest/Certificate.tsx` (port `printCertificate`, app.js:445–483)
- Modify: `apps/web/src/games/chess-quest/chess-quest.css` (add the `@media print` cert styles, port `css/style.css:490–531`)

**Behavior contract:** a normally-hidden `.cq-cert-sheet`; `@media print` hides the app and shows only the certificate (hardcoded light palette). Title + line vary by tracks completed (both 24 → "Chess Quest Champion"; Track 1 only → "First Steps Champion"; Track 2 only → "Rising Player Champion"; else "Chess Quest Adventurer" with `{total} of 48`). Stats line (`⭐ totalStars · 🗓 days · 🏰 lands done/9`), date, "Coach Pony ♞". A `printCertificate()` populates it and calls `window.print()`. Determine title via a pure `certTitle(t1, t2)` helper (unit-tested for all four branches).
- [ ] **Step 1: `certTitle` failing test → implement → pass.**
- [ ] **Step 2: Implement** the component + print CSS.
- [ ] **Step 3: Commit** `feat(chess-quest): printable quest certificate`.

---

### Task D7: Quest hub wiring + arcade tab + e2e

**Files:**
- Rewrite: `apps/web/src/games/chess-quest/index.tsx` — the quest becomes the landing.
- Modify: `apps/web/e2e/games.spec.ts`

**Hub structure:**
- Providers: `ProgressProvider` wrapping a `CopyProvider register={progress.getMode()}`.
- Two views toggled by a segmented control: **Quest** (default) and **Free play**.
  - Quest view: `QuestHeader` (opens `ProfilePanel` / `ProgressPanel` modals) + a two-column layout — `QuestMap` (select a lesson) beside `LessonCard` for the selected lesson (single column on mobile) + `GrownUpsDrawer` below. `LessonCard.onPlay(game, gameOpts)` opens the matching Phase C game component full-screen with a "← Back to quest" bar; closing it returns to the map (progress persisted).
  - Free play view: the existing 8-card arcade grid from Phase C (unchanged), each launching its game.
- A single `GAME_COMPONENTS` registry maps game id → component so both the arcade and lesson launches share one wiring; lesson launches pass `gameOpts` (pieces/pack). Games not needing opts ignore them.
- [ ] **Step 1: Rewrite `index.tsx`** with providers, Quest/Free-play toggle, modals, lesson→game launching, back navigation.
- [ ] **Step 2: Browser-verify** end to end: pick a profile name + Classic; select Day 1 (Square Race) → Play → back; **Mark day done** → the stop shows ✓, header "1 / 48 days", star total up; open Progress → streak 1, Track 1 1/24; switch to Free play → arcade still works; add a second profile → its map is empty (isolation); reload the page → first profile's progress survives.
- [ ] **Step 3: Update e2e** (`--project=parallel --no-deps`): quest landing shows the map + Day 1 card; clicking "Mark day done" flips the header day count and the stop to ✓ (assert persisted via a `page.reload()`); a lesson "Play" launches its game (e.g. Day 7 → Mate in 1, solve e1→e8→Checkmate); the Free-play toggle shows the 8-card arcade. (localStorage persists within the browser context across reloads.)
- [ ] **Step 4: Run e2e → pass. Commit** `feat(chess-quest): quest hub — map, lessons launch games, profiles; arcade as free play`.

---

### Task D8: Full verification + demo

- [ ] **Step 1:** `rtk proxy npx vitest run` (all green), `rtk proxy npx eslint src/games` (0 errors), `rtk proxy npm run build` (clean).
- [ ] **Step 2: Browser demo:** screenshot the quest map (with a couple of days done + a land badge earned), a lesson card with its diagram, the progress panel (streak + 14-day strip), and a print-preview of the certificate.
- [ ] **Step 3: Push** (PR #92 / successor per finishing-a-development-branch).

---

### Out of scope (Phase E)

- Real sounds, speech voice, confetti (the `lib/sfx` no-op and text ★ stay until E).
- Account-linked (Postgres) progress sync — still deferred; the localStorage key is namespaced so a later sync layer can migrate it.
- Minimax play-vs-computer opponent.
