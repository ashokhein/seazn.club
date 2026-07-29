# Multi-Division Joint AI Scheduling — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One AI action on the competition schedule board that schedules several divisions together — avoiding cross-division court clashes and balancing shared court use — priced with the token-weighted credit seam already on this branch.

**Architecture:** A new `buildCompetitionPack` unions the selected divisions' packs, tagging every fixture, obstacle and slot with `division_id`; the existing model ladder and `TokenMeter` run unchanged over that union; verification runs `validateAssignments` **once per division's own config over the whole joint board**, so each division's rest/window/blackout rules apply to its own fixtures while court clashes are caught across divisions; apply is a new competition-scoped usecase that locks every division, asserts every sequence, and writes all-or-nothing in one transaction.

**Tech Stack:** Next.js (see `node_modules/next/dist/docs/` — this is NOT the Next.js in your training data), TypeScript, zod, postgres.js, vitest, Playwright, `@seazn/engine`.

## Global Constraints

Copy these values verbatim. Every task's requirements implicitly include this section.

- **Worktree:** `/Users/ashokhein/github/seazn-wt-359`, branch `claude/issue-348-20260729-0956`. Never work in `/Users/ashokhein/github/seazn.club`.
- **`grep` reports several `.ts` files in this repo as "Binary file … matches". Always pass `grep -a`, or use the Read tool.**
- **Spec:** `docs/superpowers/specs/2026-07-28-multi-division-ai-design.md`, including its `Amendment — 2026-07-29` section, which supersedes §2's budget line.
- **Pricing is already built — do not reimplement it.** `apps/web/src/lib/ai-rung.ts` exports `quoteRun(lines, weights)`, `tokenBudgetForCredits(n)`, `createTokenMeter(budget, {units})`, `meterStamp(quote, meter)`. `quoteRun` with ≥2 lines already applies `credits = max(1, Σ rungs − 1)` and sizes `budget` from the **undiscounted** `Σ rungs`. `meterStamp` already emits `{discount, divisions: [{id, rung, predicted_rung, underfunded}]}` for a multi-line quote.
- **Cap:** total movable fixtures across all selected divisions > **500** → `HttpError(409, "too large — schedule per division", "AI_PLAN_TOO_LARGE")`, checked **before any credit reserve**.
- **Minimum divisions:** `division_ids.length >= 2`, else `HttpError(400, "use the division schedule page to plan a single division", "AI_PLAN_SINGLE_DIVISION")`. This prevents discount arbitrage — a lone rung-2 division would otherwise cost `max(1, 2−1) = 1` credit through the board instead of 2.
- **Rate limit:** `` rateLimit(`ai-plan-competition:${competitionId}`, { max: 3, windowSeconds: 3600 }) ``. A distinct key namespace — joint runs must not consume the per-division `ai-plan:{divisionId}` 5/hr buckets.
- **Gates, in this order:** PostHog kill switch `"ai-scheduling"` (fail-open, `fallback: true`) → `requireFeature(orgId, "scheduling.ai")` → `requireFeature(orgId, "scheduling.multi_division")` → competition lookup + per-division frozen check → wallet resolve → rate limit → pack build (cap here) → quote → `spendCredit`.
- **Determinism is contractual.** `apps/web/src/server/usecases/schedule-ai.ts:1-12` and the golden snapshots bind two builds of an identically-seeded board to be byte-identical. Sort every array on stable **domain** keys, never on UUID. When a joint sort needs a division discriminator, sort by **division name then the existing per-division key**, never by division id.
- **`SYSTEM_PROMPT` is golden-snapshotted** (`apps/web/src/server/usecases/__tests__/schedule-ai-prompt.test.ts:9`). Do NOT edit `SYSTEM_PROMPT`. Add a separate `JOINT_RULES` constant and its own snapshot test.
- **i18n:** dictionaries are FLAT dotted-key JSON at `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`. Every new user-facing string goes into all four locales with the same key set. Then run `npm run i18n:gen-keys` and `npm run i18n:check` from the repo root. CI fails on drift.
- **Every UI surface must be 375px-clean:** no horizontal page scroll; wide tables in an `overflow-x: auto` container.
- **TDD is mandatory.** Write the failing test, run it, watch it fail for the right reason, then implement. Every change ships a test that fails without it.
- **Three ways a "failing" test lies, all hit during execution — check for each:**
  1. **A fresh `toMatchSnapshot()` both passes its own red step AND poisons the following green one.** On a not-yet-existing value it writes `` = `undefined` `` into the `.snap` and matches itself. Deleting that entry *before* the red run does not help — the red run simply rewrites it, and the next green run then fails `unmatched: 1`. Delete it **after** the red run, before implementing. Verify with `snapshot.unchecked: 0` in the JSON reporter, which is what proves no orphan key survives. (Task 2, twice.)
  2. **A test that restates the implementation's own predicate can only catch one direction of error.** Task 1's obstacle test asserted "no obstacle shares `(court, start)` with any selected movable" — the implementation's filter, restated. It caught under-removal, never over-removal, and it actively blocked the correct fix. Assert the *domain* property instead.
  3. **A test can stop being able to fail for the reason its title names.** Task 1's cap-ordering test was made vacuous by a later change that moved the check earlier — it still passed, now for a different reason, and read as coverage. When you move a guard, re-check the tests that named it.
- **When a test's assertion could be satisfied by more than one constraint, neutralise the others.** Task 1's cross-person test only proves the person block because the two divisions sit on different courts with zero rest and no blackouts — otherwise a court clash would produce the same pass.
- **Substring assertions against the prompt must survive its hard wrapping.** `SYSTEM_PROMPT` and `JOINT_RULES` wrap at ~80 columns, so a pinned phrase can straddle a `\n    ` and fail against text that genuinely contains it. Task 2 hit this: written test-last, it would have prompted "fixing" the prompt's wrapping to satisfy a broken test. Normalise whitespace in the assertion (Task 2 added `flat()`/`rule()` helpers); the exact bytes stay frozen by the snapshot, so the pins are not weakened.
- **Verification commands** (run from `/Users/ashokhein/github/seazn-wt-359`):
  ```bash
  npm run typecheck --workspace apps/web
  npm run lint --workspace apps/web
  npm run openapi:gen && git diff --stat openapi/     # commit the regen
  npm run i18n:gen-keys && npm run i18n:check
  ```
  Tests need a provisioned schema:
  ```bash
  cd apps/web && DATABASE_URL=postgresql://postgres@127.0.0.1:54329/seazn_test \
    DATABASE_SSL=disable DB_SCHEMA=pr359 npx vitest run <paths>
  ```
  (Schema `pr359` is already migrated and has the sports catalog synced.)
- **Commit after each task.** Conventional Commits. End every commit message with:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`

---

## File Structure

**Create:**
- `apps/web/src/server/usecases/competition-schedule-ai.ts` — the joint pack builder, joint verifier, and `aiPlanForCompetition` orchestrator. Kept out of `schedule-ai.ts` (already 1800+ lines); imports the ladder, runner and prompt pieces from it.
- `apps/web/src/server/usecases/competition-schedule-apply.ts` — `applyCompetitionSchedule`, the all-or-nothing multi-division write.
- `apps/web/src/app/api/v1/competitions/[id]/schedule/ai-plan/route.ts`
- `apps/web/src/app/api/v1/competitions/[id]/schedule/ai-last/route.ts`
- `apps/web/src/app/api/v1/competitions/[id]/schedule/apply/route.ts`
- `apps/web/src/components/v2/board/ai-quote-card.tsx` — the N-line confirm card. One line renders the single-division card (#348); N lines render the per-division breakdown with the discount row (#350).
- `apps/web/src/components/v2/board/ai-division-picker.tsx`
- Tests mirroring each of the above under the sibling `__tests__/` directory.

**Modify:**
- `apps/web/src/server/usecases/schedule-ai.ts` — export the pieces the joint module needs; add `JOINT_RULES` usage. Do not restructure it.
- `apps/web/src/server/usecases/schedule-ai-prompt.ts` — add `JOINT_RULES`.
- `apps/web/src/server/api-v1/schemas.ts` — joint request/response schemas.
- `apps/web/src/server/api-v1/openapi.ts` — register the three new routes.
- `apps/web/src/components/v2/schedule-board.tsx:149` — the `aiAvailable` gate.
- `apps/web/src/components/v2/board/ai-console.tsx` — mount the quote card; pass `rung`.
- `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`
- `scripts/smoke.ts`

---

## Rulings made during execution

Decisions taken after the plan was written. They **override** the task text below where they conflict, and later tasks must not "correct" them back.

**R1 — `schedule.ts` and `schedule-ai.ts` were edited by Task 1.** Task 1's Files block said "read, do not edit"; that was lifted. `buildSchedulePack`'s `BuildPackOptions` gained optional `extraExisting` and `excludeDivisionIds`; `siblingAssignments` gained `excludeDivisionIds`; `OTHER_DIVISION_LABEL` and `OCCUPYING` are now exported. All additive — every existing caller is unchanged. **Task 3 must not re-add `OTHER_DIVISION_LABEL`.**

**R2 — obstacle dedupe keys on `(division_id, court, from, to)`**, not the plan's `(court, from, to)`. Without division identity, two selected divisions' immovable fixtures at the same court and span collapse into one, hiding a real fixture from both the model and the verifier.

**R3 — divisions sort on `(name, slug)`**, not `(name, id)`. Since drafts accumulate forward, build order decides draft *content*, so a UUID tie-break would make two identically-seeded boards produce different drafts. `createDivision` enforces a unique slug; it does not enforce a unique name.

**R4 — the draft is a legality hint, explicitly not a balance hint.** Divisions are drafted sequentially, each seeing the earlier ones' assignments, so division 1 takes the early slots and later ones stack behind it. That is deliberate: legal-but-unbalanced beats balanced-but-clashing for a hint, and chunked interleaving would risk the determinism contract for modest gain. **`JOINT_RULES` (Task 2) must tell the model to rebalance rather than anchor**, since J4 asks for exactly the fairness the draft does not have.

**R5 — `CompetitionPackDivision.draftPlaced`** carries how many of a division's movable fixtures the draft actually placed. `slotFixtures` returns unplaced fixtures in `result.conflicts`, which `schedule-ai.ts` discards — so without this the pack silently comes back short. **`draftPlaced < movableIds.length` means "did not fit" only in `generate` mode**; `repair` and `refine` derive `draft` differently.

**R6 — zero-movable divisions are dropped from the run before quoting** (Task 4), so they are never charged. If fewer than 2 remain, the `>= 2 divisions` rule fires with its 400. Refusing an entire joint run because one of five divisions is already fully scheduled is wrong for a *joint* action, and charging for a division that was not solved is worse.

**R7 — `movableIds` iteration order is not stable.** Only `.size` and membership are safe. Tasks 3 and 4 must never serialize `[...movableIds]` into a prompt or an event payload.

**R8 — mixed division timezones.** All internal comparisons are epoch ms, but `pack.draft` and each division's settings keep their own division's `zonedIso` rendering, so on a mixed-tz competition the arrays read as non-monotone. `JOINT_RULES` must say so (Task 2), and the board must show which timezone it is rendering in (Task 8).

**R9 — three cross-division cases Task 3 must test**, all discovered in Task 1 and none of them fixable there:
- **Person overlap in the drafts.** A person in an entrant of division A and one of division B appears in *neither* division's `pack.people`, because each pack lists only persons in ≥2 of its **own** entrants. The fixed board now carries `people`; the drafts structurally cannot. `verifyJoint` sees the whole board and owns this.
- **`parallelism: "block"` asymmetry.** `extraExisting` feeds block-mode exclusivity, so a division refuses to overlap *earlier* divisions' drafts but never later ones.
- **Cross-division gap is charged at the drafting division's `gapMinutes`.** `verifyJoint` uses each division's own config, so it can legitimately reject the draft it was handed. Test that case explicitly rather than discovering it in a repair round.

---

## Task 1: Joint pack builder

**Files:**
- Create: `apps/web/src/server/usecases/competition-schedule-ai.ts`
- Test: `apps/web/src/server/usecases/__tests__/competition-schedule-pack.test.ts`
- Reference (read, do not edit): `apps/web/src/server/usecases/schedule-ai.ts:125-224` (pack types), `:256` (`buildSchedulePack`), `:293-295` (the 500 cap), `:434-454` (obstacle assembly), `apps/web/src/server/usecases/schedule.ts:271-297` (`siblingAssignments`)

**Interfaces:**
- Consumes: `buildSchedulePack(auth, divisionId, opts): Promise<{pack: SchedulePack; movableIds: Set<string>}>` and every `Pack*` type from `schedule-ai.ts`. `SchedulePack` is quoted in full in the recon map; re-read `schedule-ai.ts:125-224` before starting.
- Produces — later tasks depend on these exact names:
  ```ts
  export interface CompetitionPackDivision {
    id: string;
    name: string;
    sport: string;
    tz: string;
    settings: PackSettings;          // that division's own settings, verbatim
    movableIds: string[];            // sorted, stable
  }

  export interface CompetitionPackFixture extends PackFixture {
    division_id: string;
  }

  export interface CompetitionPackObstacle extends PackObstacle {
    /** null when the obstacle comes from a division NOT in this run. */
    division_id: string | null;
  }

  export interface CompetitionPackAssignment extends PackAssignment {
    division_id: string;
  }

  export interface CompetitionPack {
    mode: "generate" | "refine" | "repair";
    competition: { id: string; name: string };
    divisions: CompetitionPackDivision[];      // sorted by (name, slug) — see R3
    /** Union of every selected division's court labels, sorted. */
    courts: string[];
    /** Court labels that do NOT appear in every selected division — the board
     *  warns on these, because cross-division court identity is a string match
     *  and nothing else. */
    divergentCourts: string[];
    entrants: (PackEntrant & { division_id: string })[];
    people: PackPerson[];
    fixtures: { movable: CompetitionPackFixture[]; obstacles: CompetitionPackObstacle[] };
    draft: CompetitionPackAssignment[];
    instruction: string;
    prior: { instruction: string; assignments: CompetitionPackAssignment[] } | null;
  }

  export async function buildCompetitionPack(
    auth: AuthCtx,
    competitionId: string,
    divisionIds: string[],
    opts: { mode: "generate" | "refine" | "repair"; instruction: string;
            prior?: { instruction: string; assignments: CompetitionPackAssignment[] } },
  ): Promise<{ pack: CompetitionPack; movableIds: Set<string> }>;

  /** Total movable fixtures across the whole joint pack. */
  export const COMPETITION_MOVABLE_CAP = 500;
  ```

**Implementation notes:**
- Build each division's pack by calling the existing `buildSchedulePack` per division. Do **not** duplicate its SQL.
- The per-division `buildSchedulePack` enforces its own 500 cap; the joint cap is on the **sum**, and must be checked after the union.
- `obstacles`: for a division IN the run, its own immovable fixtures (`division_id` = that division). For a division NOT in the run, every placement of it (`division_id: null`, label `"Other division"` as today). The per-division pack's `siblingAssignments` already contributes obstacles for *all* siblings — you must **remove** the siblings that are themselves in this run, or their fixtures appear both as movable and as obstacles. Deduplicate on `(court, from, to)`.
- Obstacle synthetic ids: `toObstacleAssignments` in `schedule-ai.ts:864-873` uses `obstacle:${i}`. The joint verifier (Task 3) must generate ids unique across the union — use `obstacle:${divisionIndex}:${i}` or a running counter over the merged, sorted list.
- Sorting: divisions by `(name, id)`; movable by `(division name, round, seq, ext_key, home, away)`; obstacles by `(court, from, to, label)`; courts lexicographic.
- `divergentCourts` = labels present in at least one but not all selected divisions.

- [ ] **Step 1: Write the failing tests**

`apps/web/src/server/usecases/__tests__/competition-schedule-pack.test.ts`. Follow the `HAS_DB` convention used by `schedule-ai-pack.test.ts:18`:

```ts
const HAS_DB = !!process.env.DATABASE_URL;
```

Cases (each its own `it`):
1. `"unions two divisions' movable fixtures and tags every one with its division"` — seed 2 divisions, assert `pack.fixtures.movable.length === a + b` and every entry has a `division_id` matching one of the two.
2. `"courts is the union of both divisions' labels, sorted"` — division A `["Court 1","Court 2"]`, division B `["Court 2","Court 3"]` → `["Court 1","Court 2","Court 3"]`.
3. `"divergentCourts names the labels that are not in every division"` — same seed → `["Court 1","Court 3"]`; and with identical court lists → `[]`.
4. `"a selected division's fixtures never appear as obstacles"` — assert no obstacle's `(court, from, to)` matches a movable fixture's current slot of a selected division.
5. `"an excluded division's placements are obstacles with a null division_id"` — seed 3 divisions, select 2.
6. `"per-division settings are carried verbatim, not merged"` — division A `matchMinutes: 30`, division B `matchMinutes: 45` → `pack.divisions` carries both unchanged.
7. `"over the cap refuses with AI_PLAN_TOO_LARGE"` — stub/seed so the summed movable count is 501; assert `HttpError` with `status: 409` and `code: "AI_PLAN_TOO_LARGE"`. Also assert 500 exactly is accepted.
8. `"two builds of an identically seeded competition are byte-identical"` — the determinism contract. Redact UUIDs the way `schedule-ai-pack.test.ts:151` does and compare `JSON.stringify`.

- [ ] **Step 2: Run them and watch them fail**

```bash
cd apps/web && DATABASE_URL=postgresql://postgres@127.0.0.1:54329/seazn_test DATABASE_SSL=disable DB_SCHEMA=pr359 \
  npx vitest run src/server/usecases/__tests__/competition-schedule-pack.test.ts
```
Expected: fails to resolve `buildCompetitionPack`.

- [ ] **Step 3: Implement `competition-schedule-ai.ts` (pack half only)**
- [ ] **Step 4: Re-run — all green. Then run the existing pack suite to prove no regression:**

```bash
npx vitest run src/server/usecases/__tests__/schedule-ai-pack.test.ts
```

- [ ] **Step 5: `npm run typecheck --workspace apps/web`, then commit**

---

## Task 2: Joint prompt rules

**Files:**
- Modify: `apps/web/src/server/usecases/schedule-ai-prompt.ts`
- Test: `apps/web/src/server/usecases/__tests__/schedule-ai-prompt.test.ts`

**Interfaces:**
- Produces: `export const JOINT_RULES: string;`

**Implementation notes:**
- `SYSTEM_PROMPT` (`schedule-ai-prompt.ts:21-80`) is frozen by a golden snapshot. **Do not touch it.** `JOINT_RULES` is appended to it by the joint runner (Task 3) as `` `${SYSTEM_PROMPT}\n\n${JOINT_RULES}` ``.
- The joint pack's fixtures carry `division_id`, and each division has its own slot config, so the rules must state:
  - **J1** Every fixture carries a `division_id`. Its `court_label` must be a court that fixture's own division lists in `divisions[].settings.courts`.
  - **J2** A court is shared across divisions when the label matches exactly. Two fixtures from different divisions must never overlap on the same `court_label`.
  - **J3** Each division has its own `matchMinutes`, `gapMinutes`, session windows and blackouts under `divisions[]`. Apply each fixture's own division's values — they are not interchangeable.
  - **J4** Balance prime slots across divisions. No division may be pushed entirely to the end of the day while another takes every early court.
  - **J5** The `draft` is a **legality** hint, not a balance hint (ruling R4). It is built division by division, so earlier divisions hold the early slots — rebalance it under J4 rather than anchoring on it. A division whose `draftPlaced` is below its movable count has a **partial** draft; place the remainder yourself (ruling R5).
  - **J6** Divisions may run in different timezones (ruling R8). Every `scheduled_at` carries its own division's UTC offset, so the arrays are not necessarily in clock order — compare instants, not strings.
  - **J7** The shared-player map covers **within-division** sharing only — each division's map is filtered to its own entrants (`schedule-ai.ts:540-543`), so a person rostered into one entrant of A and one of B is in neither. The verifier additionally checks people across divisions, and a rejection names the person and both entrants (ruling R10). Without this the model is graded on data it does not hold, cannot act on the rejection, and re-proposes the same placement until the token budget stops it.
  - **Ranking matters:** J1-J3, J6 and J7 are hard — the verifier rejects violations. **J4 and J5 are goals**, ranked with the soft goals and subordinate to S1 (the organiser's instruction), which `SYSTEM_PROMPT:52-54` says outranks everything except hard rules. Shipping J4 as a hard rule collides with the base prompt's own worked example, "juniors always before 2pm".
  - Output format is unchanged: one flat `assignments` array. Do not add a division field to the output — the server resolves each `fixture_id` to its division.
- Label the rules `J1`–`J7` so they match the existing `H1`–`H7` / `S1`–`S5` convention that `schedule-ai-prompt.test.ts:26` asserts on.

- [ ] **Step 1: Write the failing tests** (append to `schedule-ai-prompt.test.ts`)

```ts
describe("JOINT_RULES (issue #350)", () => {
  it("is frozen", () => {
    expect(JOINT_RULES).toMatchSnapshot();
  });

  it("labels every joint rule J1..J7", () => {
    for (const id of ["J1", "J2", "J3", "J4", "J5", "J6", "J7"]) {
      expect(JOINT_RULES).toContain(id);
    }
  });

  it("does not alter the frozen single-division system prompt", () => {
    expect(SYSTEM_PROMPT).not.toContain("J1");
    expect(SYSTEM_PROMPT).not.toContain("division_id");
  });

  it("tells the model the output shape is unchanged — no division field", () => {
    expect(JOINT_RULES).toMatch(/assignments/i);
    expect(JOINT_RULES).toMatch(/do not add/i);
  });
});
```

- [ ] **Step 2: Run and watch fail** — `npx vitest run src/server/usecases/__tests__/schedule-ai-prompt.test.ts`
- [ ] **Step 3: Add `JOINT_RULES`**
- [ ] **Step 4: Re-run. Confirm the pre-existing `it("system prompt is frozen")` at `:9` still passes untouched.** If that snapshot changed, you edited `SYSTEM_PROMPT` — revert it.
- [ ] **Step 5: Commit**

---

## Task 3: Joint verifier + joint runner

**Files:**
- Modify: `apps/web/src/server/usecases/competition-schedule-ai.ts`
- Modify: `apps/web/src/server/usecases/schedule-ai.ts` — export what the joint module needs (`runLadder`, `planRungs`, `MAX_TOKENS`, `MAX_REPAIR_ROUNDS`, `isBlocking`, `aiReasoning`, `schedulingAiModel`, `ROUND_TIMEOUT_MS`). Export only; change no behaviour.
- Test: `apps/web/src/server/usecases/__tests__/competition-schedule-verify.test.ts` (pure, no DB — model on `schedule-ai-run.test.ts`)

**R10 — the cross-division person conflict MUST name the person and both entrants.** This is a contract, promised to the model in `JOINT_RULES` and required for the repair loop to converge.

Each division's `packPeople` is filtered to that division's own entrants (`schedule-ai.ts:540-541`), so a person rostered into one entrant of A and one of B appears in **neither** source map — and H4 tells the model to avoid overlaps for *"two entrants sharing a person in the shared-player map"*, a map that is empty for exactly this case. The model therefore cannot avoid the collision from the data it holds. If `verifyJoint` reports a bare `person_overlap` with no names, the repair round has nothing to act on and the model will re-propose the same placement — an infinite thrash on a metered, credit-consuming path, terminated only by the token budget. `Conflict.detail` must carry the person id and both entrant ids. Add a test asserting that, not merely that a conflict is raised.

**Interfaces:**
- Consumes: `validateAssignments(assignments, config, existing, dependencies): Conflict[]` from `@seazn/engine` (`packages/engine/src/scheduling/calendar.ts:419`); `Assignment` has an optional `divisionId` field already (`calendar.ts:58`).
- Produces:
  ```ts
  export function toJointEngineAssignments(
    plan: AiSchedulePlan,
    pack: CompetitionPack,
  ): Assignment[];   // endAt uses EACH fixture's own division matchMinutes

  export function jointStructuralCheck(
    plan: AiSchedulePlan,
    movableIds: Set<string>,
    pack: CompetitionPack,
  ): string | null;

  /** Obstacles as engine assignments. Synthetic ids MUST be unique across the
   *  union — `obstacle:${divisionIndex}:${i}`, never the per-division
   *  `obstacle:${i}` of schedule-ai.ts:864, which collides when concatenated. */
  export function toJointObstacleAssignments(pack: CompetitionPack): Assignment[];

  /** Feed dependencies over the union — mirrors packFeedDependencies
   *  (schedule-ai.ts:918-926) across every division's movable fixtures. */
  export function jointFeedDependencies(pack: CompetitionPack): OrderDependency[];

  /** Per-division verify config — mirrors verifyConfig (schedule-ai.ts:875-913)
   *  including its deliberate `startWindows: []` drop, but reads
   *  `division.settings` instead of `pack.settings`. */
  export function verifyConfigFor(division: CompetitionPackDivision): Parameters<typeof validateAssignments>[1];

  export function verifyJoint(
    plan: AiSchedulePlan,
    pack: CompetitionPack,
  ): Conflict[];

  export async function runCompetitionAiPlan(
    pack: CompetitionPack,
    movableIds: Set<string>,
    modelOverride?: string,
    providerName?: ProviderName,
    meter?: TokenMeter,
  ): Promise<CompetitionPlanResult>;
  ```

**THE CENTRAL DESIGN DECISION — read carefully.**

`validateAssignments` takes **one scalar config** (one `matchMinutes`, one `gapMinutes`, one `blackouts[]`, one `sessionWindows[]`, one `constraints`). Divisions legitimately differ on all of them. Do **not** merge configs into a "strictest" one — that silently applies division A's session window to division B's fixtures.

`verifyJoint` runs **one `validateAssignments` pass per division**:

```ts
export function verifyJoint(plan: AiSchedulePlan, pack: CompetitionPack): Conflict[] {
  const all = toJointEngineAssignments(plan, pack);
  const obstacles = toJointObstacleAssignments(pack);
  const deps = jointFeedDependencies(pack);
  const seen = new Set<string>();
  const out: Conflict[] = [];
  for (const division of pack.divisions) {
    const mine = all.filter((a) => a.divisionId === division.id);
    if (mine.length === 0) continue;
    // Everything NOT this division's — the other divisions' proposed slots plus
    // every obstacle — goes in as `existing`. That is what makes a cross-division
    // court clash visible: the other division's fixture is on the board, so this
    // division's fixture collides with it and is reported. The other side of the
    // same clash is reported by that division's own pass.
    const others = all.filter((a) => a.divisionId !== division.id);
    for (const c of validateAssignments(mine, verifyConfigFor(division), [...others, ...obstacles], deps)) {
      const key = `${c.fixtureId}|${c.reason}|${c.detail ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(c);
    }
  }
  return out.sort((a, b) => cmp(a.fixtureId, b.fixtureId) || cmp(a.reason, b.reason));
}
```

`verifyConfigFor(division)` mirrors `verifyConfig` in `schedule-ai.ts:875-913` — same ISO→epoch-ms conversion, same deliberate `startWindows: []` drop, same `fieldFairness:"off" / parallelism:"mixed" / crossPersonClash:"warn"` — but reads `division.settings` instead of `pack.settings`.

`jointStructuralCheck` mirrors `structuralCheck` (`schedule-ai.ts:802-835`) with one change: the court check is **per division** — a fixture's `court_label` must appear in **its own division's** `settings.courts`, not merely in the union. A fixture placed on a court its division does not have is a structural error naming the fixture and the court.

`runCompetitionAiPlan` mirrors `runAiPlan` (`schedule-ai.ts:1003`): same round loop, same `meter.canStartRound()` / `meter.clampRound(MAX_TOKENS)` / `meter.add(roundOutput)` placement (charge the meter **before** the refusal and parse-failure throws), same corrective retry, same `MAX_REPAIR_ROUNDS`, same best-so-far selection. Differences: it sends `` `${SYSTEM_PROMPT}\n\n${JOINT_RULES}` `` as the system prompt, `JSON.stringify(competitionPack)` as the first user turn, and calls `jointStructuralCheck` / `verifyJoint`.

- [ ] **Step 1: Write the failing tests** — `competition-schedule-verify.test.ts`, pure, hand-built `CompetitionPack` fixtures (no DB, no SDK):

1. `"a cross-division court clash is reported for BOTH fixtures"` — division A fixture and division B fixture on `"Court 1"` at the same instant → two conflicts, `reason: "court"`, one per fixture id.
2. `"divisions on different courts at the same time are clean"` → `[]`.
3. `"each division's own matchMinutes decides its fixture's end"` — A `matchMinutes: 30` at 09:00, B `matchMinutes: 90` at 09:00 on different courts, then a third fixture on B's court at 10:00: clean for a 30-minute reading, clashing for a 90-minute one. Assert the clash IS reported (proving per-division duration, not a shared one).
4. `"a division's session window is not applied to another division's fixtures"` — A window 09:00–12:00, B window 14:00–18:00; B fixture at 15:00 must be clean, and A fixture at 15:00 must conflict.
5. `"a division's blackout does not blackout another division"`.
6. `"jointStructuralCheck rejects a fixture placed on a court its own division does not have"` — union contains `"Court 3"`, division A does not → error string naming the fixture and `"Court 3"`.
7. `"jointStructuralCheck accepts a fixture on a court its own division has"`.
8. `"duplicate conflicts across per-division passes are reported once"`.
9. `"obstacle ids are unique across the union"` — two divisions each contributing obstacles → no duplicate `fixtureId` among the synthetic obstacle assignments.

**Plus the three cases ruling R9 hands to this task.** Each was found during Task 1 and is unfixable there — `verifyJoint` is the only place that sees the whole board:

10. `"a person shared across two divisions' entrants is caught as an overlap"` — the important one. Each division's pack lists only persons appearing in ≥2 of its **own** entrants, so a person in one entrant of A and one of B is in *neither* `pack.people`. The joint pack's merged `people` is what makes this visible. Seed exactly that shape and put the two fixtures on **different courts** at overlapping times — different courts is what proves the assertion is the person check and not a court clash.
11. `"a division's parallelism:'block' setting is applied to its own fixtures only"` — `extraExisting` feeds block-mode exclusivity asymmetrically (a division refuses to overlap *earlier* divisions' drafts, never later ones). Pin the intended semantics so the asymmetry cannot silently change.
12. `"verifyJoint may legitimately reject a draft it was handed"` — cross-division gap is charged at the *drafting* division's `gapMinutes`, while `verifyJoint` uses each division's own. Seed two divisions with different `gapMinutes` sharing a court, so the draft is legal to the drafter and illegal to the verifier. Assert the conflict IS reported rather than swallowed. This is expected behaviour, not a bug — the test exists so a later change cannot quietly make the verifier agree with a draft it should not.

- [ ] **Step 2: Run and watch fail**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Re-run green; then `npx vitest run src/server/usecases/__tests__/schedule-ai-run.test.ts src/server/usecases/__tests__/schedule-ai-ladder.test.ts` to prove the single-division path is untouched**
- [ ] **Step 5: Commit**

---

## Task 4: `aiPlanForCompetition` orchestrator

**Files:**
- Modify: `apps/web/src/server/usecases/competition-schedule-ai.ts`
- Test: `apps/web/src/server/usecases/__tests__/competition-schedule-ai-route.test.ts` (DB-gated; model on `schedule-ai-route.test.ts`, which mocks `@/server/ai/select-provider`, PostHog, and the Redis counter)

**Interfaces:**
- Consumes: `quoteRun`, `createTokenMeter`, `meterStamp`, `schedulingRungWeights` from `@/lib/ai-rung`; `spendCredit`, `walletIdFor` from `@/lib/credits`; `requireFeature` from `@/lib/entitlements`; `isServerFeatureEnabled` from `@/lib/posthog-server`; `rateLimit` from `@/lib/rate-limit`.
- Produces:
  ```ts
  export async function aiPlanForCompetition(
    auth: AuthCtx,
    competitionId: string,
    input: AiCompetitionPlanRequest,
  ): Promise<AiCompetitionPlanResponse>;
  ```

**Gate order — implement exactly this, it is the acceptance criterion:**

1. Kill switch — `isServerFeatureEnabled("ai-scheduling", distinctId, { orgId, fallback: true })` → 403 `FEATURE_DISABLED`.
2. `requireFeature(orgId, "scheduling.ai")` → 402.
3. `requireFeature(orgId, "scheduling.multi_division")` → 402. **This key has no server enforcement anywhere today — you are adding the first.**
4. `input.division_ids.length >= 2` → else 400 `AI_PLAN_SINGLE_DIVISION`.
5. Load the competition and its divisions in one `withTenant`. Unknown competition → 404. Any requested id not in this competition → 404 naming it. Any selected division with `schedule_locked` → 409 `SCHEDULE_LOCKED` naming the division.
6. **422 naming the division** for a division that cannot be planned — zero courts configured (spec §11). Before any reserve.
6b. **Drop zero-movable divisions from the run (ruling R6)** — before quoting, so they are never charged. Report which were dropped in the response. If fewer than 2 remain, fall back to the `>= 2 divisions` 400 at step 4. Do NOT let the per-division builder's `422 AI_PLAN_EMPTY_SCOPE` escape: refusing a whole joint run because one of five divisions is already fully scheduled is wrong for a joint action, and charging for a division that was never solved is worse.
7. `walletIdFor(orgId)`.
8. `` rateLimit(`ai-plan-competition:${competitionId}`, { max: 3, windowSeconds: 3600 }) ``.
9. `buildCompetitionPack(...)` — the 500 cap fires here, still before any reserve.
10. Quote:
    ```ts
    const quote = quoteRun(
      pack.divisions.map((d) => ({
        key: d.id,
        input: {
          movableFixtures: d.movableIds.length,
          entrants: pack.entrants.filter((e) => e.division_id === d.id).length,
          courts: d.settings.courts.length,
        },
        ...(input.rung_overrides?.[d.id] !== undefined ? { chosen: input.rung_overrides[d.id]! } : {}),
      })),
      schedulingRungWeights(),
    );
    const meter = createTokenMeter(quote.budget, { units: movableIds.size });
    ```
11. `spendCredit(walletId, orgId, quote.credits, ...)` around the ladder.

**Events (spec §10):** on success insert `competition_events` type **`schedule.ai_generated_multi`**; on failure **`schedule.ai_failed_multi`**. `competition_events.type` is plain `text` with no CHECK constraint or enum (`db/migration/v2-engine/tables/V208__competition_events.sql`) — **no migration is needed.** Payload:

```ts
{
  division_ids: string[],          // sorted
  mode: input.mode,
  model,
  usage: result.usage,
  cost_usd,
  pack_units: movableIds.size,
  ...meterStamp(quote, meter),     // supplies credits, discount, budget, spent_tokens,
                                   // stopped_on_budget, underfunded, divisions[]
  ...(result.escalated_from ? { escalated_from, rungs_tried, warnings, movable } : {}),
}
```

**Failure semantics (spec §11):** budget exhausted with nothing usable, or no valid joint schedule → the `spendCredit` hold is **released, no charge** (this is automatic — `spendCredit` releases on throw), and the failure event is still written.

- [ ] **Step 1: Write the failing tests.** One `it` per gate, asserting order by proving the *earlier* gate fires when both would:
1. `"kill switch → 403 before the paid gate"`
2. `"no scheduling.ai → 402"`
3. `"has scheduling.ai but not scheduling.multi_division → 402"` — the new enforcement.
4. `"a single division id → 400 AI_PLAN_SINGLE_DIVISION, and no credit is spent"` — assert the wallet balance is unchanged.
5. `"a division id from another competition → 404 naming it"`
6. `"a frozen division → 409 SCHEDULE_LOCKED naming the division, before any spend"`
7. `"a division with zero courts → 422 naming the division, before any spend"`
8. `"501 summed movable fixtures → 409 AI_PLAN_TOO_LARGE, wallet untouched"`
9. `"4th call in the hour → 429"` — mock the Redis counter as `schedule-ai-route.test.ts:721` does.
10. `"charges max(1, Σ rungs − 1) credits"` — two rung-1 divisions → 1 credit debited; assert the ledger row `delta: -1`.
11. `"the budget is sized from the undiscounted rung total"` — same seed → event payload `budget === tokenBudgetForCredits(2)` (64000), not 32000.
12. `"writes schedule.ai_generated_multi with the per-division breakdown"` — assert `payload.divisions` has one entry per division with `rung`, `predicted_rung`, `underfunded`; and `payload.discount === 1`.
13. `"a failed run releases the hold, charges nothing, and writes schedule.ai_failed_multi"`
14. `"a joint run does not consume the per-division 5/hr bucket"` — run the joint endpoint, then assert a per-division run still succeeds.

- [ ] **Step 2: Run and watch fail**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Re-run green; then `npx vitest run src/server/usecases/__tests__/schedule-ai-route.test.ts` to prove the per-division path is untouched**
- [ ] **Step 5: Commit**

---

## Task 5: Schemas + routes + OpenAPI

**Files:**
- Modify: `apps/web/src/server/api-v1/schemas.ts`
- Modify: `apps/web/src/server/api-v1/openapi.ts` (competition routes are registered at `:46-51`; the division ai-plan entry is at `:226` — follow both patterns)
- Create: `apps/web/src/app/api/v1/competitions/[id]/schedule/ai-plan/route.ts`
- Create: `apps/web/src/app/api/v1/competitions/[id]/schedule/ai-last/route.ts`
- Test: `apps/web/src/server/usecases/__tests__/competition-schedule-ai-route.test.ts` (extend Task 4's file)

**Interfaces:**
```ts
export const AiCompetitionPlanRequest = z.object({
  division_ids: z.array(Uuid).min(2).max(20),
  instruction: z.string().min(1).max(2000),
  mode: z.enum(["generate", "refine", "repair"]).default("generate"),
  rung_overrides: z.record(Uuid, RungLiteral).optional(),
  prior: z.object({
    instruction: z.string(),
    assignments: z.array(z.object({
      fixture_id: Uuid, scheduled_at: IsoDateTime, court_label: z.string(), division_id: Uuid,
    })),
  }).optional(),
});

export const AiCompetitionPlanResponse = z.object({
  proposal: z.array(z.object({
    fixture_id: z.string(), scheduled_at: z.string(), court_label: z.string(), division_id: z.string(),
  })),
  unschedulable: z.array(z.object({ fixture_id: z.string(), reason: z.string() })),
  warnings: z.array(ScheduleConflict),
  blocking: z.array(ScheduleConflict),
  divergent_courts: z.array(z.string()),
  divisions: z.array(z.object({ id: z.string(), name: z.string(), movable: z.number().int() })),
  summary: z.string(),
  usage: z.object({ input_tokens: z.number().int(), output_tokens: z.number().int(), repair_rounds: z.number().int() }),
  ...AiRunPriceFields,     // already declares discount + divisions[] — schemas.ts:1562-1590
});
```

`RungLiteral` already exists in `schemas.ts` (added for #348). `AiRunPriceFields` already exists and already carries the joint fields — reuse both, do not redeclare.

Routes follow `apps/web/src/app/api/v1/divisions/[id]/schedule/ai-plan/route.ts:14` exactly — the `v1()` wrapper is load-bearing (it propagates `HttpError.code` and `extra.usage`, which the generic handler drops). Auth: `requireResourceAuth(req, "competition", id, "write")` for the plan, `"read"` for `ai-last`. `requireResourceAuth` already supports `"competition"` (`apps/web/src/server/api-v1/auth.ts:303-318`).

- [ ] **Step 1: Write the failing route tests** — malformed body → 400; `division_ids` with 1 entry → 400; a caller without write on the competition → 403; happy path returns `proposal[].division_id` populated and `credits`/`discount`/`divisions` present.
- [ ] **Step 2: Run and watch fail**
- [ ] **Step 3: Implement schemas, routes, OpenAPI registration**
- [ ] **Step 4: Re-run green, then:**
```bash
npm run openapi:gen && git diff --stat openapi/
```
Both `openapi/v1.json` and `openapi/v1.public.json` must change. Commit the regen — CI's drift gate fails otherwise, and it runs **before** the unit-test step, so a stale spec hides every test result.
- [ ] **Step 5: Commit**

---

## Task 6: Atomic multi-division apply

**Files:**
- Create: `apps/web/src/server/usecases/competition-schedule-apply.ts`
- Create: `apps/web/src/app/api/v1/competitions/[id]/schedule/apply/route.ts`
- Test: `apps/web/src/server/usecases/__tests__/competition-schedule-apply.test.ts` (DB-gated)
- Reference: `apps/web/src/server/usecases/schedule.ts:463` (`applySchedule`) — read it fully first.

**Interfaces:**
```ts
export interface CompetitionApplyDivision {
  division_id: string;
  expected_seq: number;
  assignments: { fixture_id: string; scheduled_at: string; court_label: string }[];
}

export async function applyCompetitionSchedule(
  auth: AuthCtx,
  competitionId: string,
  input: { divisions: CompetitionApplyDivision[]; source: "ai"; ai?: AiApplyAudit },
): Promise<{ applied: number; conflicts: ScheduleConflict[] }>;
```

**Why this is new work:** today's apply is client-orchestrated (`apps/web/src/components/v2/board/ai-apply.ts:163`) and calls `POST /stages/{stageId}/schedule/apply` once per stage. `applySchedule` (`schedule.ts:463`) takes **one** division-level advisory lock, asserts **one** division's seq, and bumps **one** division's seq. Nothing today spans divisions. Spec §8 requires "one transaction writes all divisions or nothing".

**Implementation notes:**
- One `withTenant(auth.orgId, tx => …)` transaction wrapping everything.
- Take `pg_advisory_xact_lock(hashtext('division:' || id))` for **every** division, in **sorted division-id order**. Sorting is the deadlock guard — two concurrent joint applies over overlapping division sets that lock in different orders will deadlock.
- `assertFreshSeq(tx, divisionId, expected_seq)` per division (`schedule.ts:647-661`) — any stale seq aborts the whole transaction, so nothing is written.
- `assertCompetitionNotFrozen(orgId, competitionId, tx)` once.
- `divisionLockState` per division — a locked division aborts everything (422).
- Validate jointly before writing: reuse `verifyJoint`-style per-division passes over the merged board so a cross-division court clash is a 409, not a silent double-book.
- Bump every division's `seq`; append a `schedule_applied` division event per division with the shared `ai` audit block. As in `schedule.ts:572`, overwrite the client's `ai.model` with `schedulingAiModel()`.
- Call `afterScheduleWrite(divisionId, competitionId, "schedule")` for each division **outside** the transaction.

- [ ] **Step 1: Write the failing tests**
1. `"writes every division's assignments in one go"`
2. `"a stale expected_seq on the SECOND division rolls back the FIRST"` — the atomicity test. Seed 2 divisions, pass a correct seq for A and a stale one for B, expect the throw, then assert **division A's fixtures are unchanged in the DB**. This is the test that fails without a shared transaction.
3. `"a cross-division court clash is a 409 and writes nothing"`
4. `"a locked division aborts the whole apply"`
5. `"every division's seq is bumped exactly once on success"`
6. `"a schedule_applied event is appended per division carrying the shared ai audit"`
7. `"locks are taken in sorted division-id order"` — assert on the emitted SQL order via a query spy, or extract the ordering into a pure exported helper and test that directly. Prefer the pure helper.

- [ ] **Step 2: Run and watch fail**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Re-run green; then `npx vitest run src/server/usecases/__tests__/schedule.test.ts` to prove single-division apply is untouched**
- [ ] **Step 5: `npm run openapi:gen`, commit**

---

## Task 7: The N-line quote card + division picker

**Files:**
- Create: `apps/web/src/components/v2/board/ai-quote-card.tsx`
- Create: `apps/web/src/components/v2/board/ai-division-picker.tsx`
- Create: `apps/web/src/components/v2/board/__tests__/ai-quote-card.test.tsx`
- Modify: `apps/web/src/components/v2/board/ai-console.tsx` — mount the card in `BriefStep` (the step body is at `:831-971`; the run button is at `:948`), and add `rung` to the request body built at `:359`.
- Modify: `apps/web/src/components/v2/board/ai-console-state.ts` — add `rung: number | null` (null = follow the prediction) and a `SET_RUNG` action.

**REQUIRED SUB-SKILL: use the `frontend-design` skill before writing any markup.** This is a paid-action confirm surface — the number on it is money. It must read as deliberate, not as a default form.

**Interfaces:**
```ts
export interface QuoteCardLine {
  key: string;            // division id; the single-division card passes the division id too
  label: string | null;   // division name; null renders the single-division layout
  input: RungInput;       // { movableFixtures, entrants, courts }
  chosen: number | null;  // null = follow the prediction
}

export function AiQuoteCard(props: {
  lines: QuoteCardLine[];
  onChange: (key: string, rung: number | null) => void;
  msg: ReturnType<typeof useMsg>;
  busy: boolean;
}): JSX.Element;
```

**Implementation notes:**
- The card computes its quote **client-side** with the very same pure function the server uses: `quoteRun(lines, schedulingRungWeights())` from `@/lib/ai-rung`. That module is pure with no I/O precisely so it can be imported into a client bundle — do not fetch a quote from the server, and do not reimplement the arithmetic. The server always recomputes; the client's number is advisory and must agree.
- `lines.length === 1` → the #348 layout: prediction line, a 1/2/3 segmented control with the predicted rung pre-selected, the below-predicted warning, and the CTA count.
- `lines.length > 1` → the #350 layout: one row per division (name, rung chips, est tokens), a discount row, a total row.
- Below-predicted selection on any line → inline warning: *may stop before a full schedule*.
- `est_tokens > budget` → the "very large" warning (spec §8).
- The segmented control must be a real radio group: `role="radiogroup"` with `aria-checked` on each option, arrow-key navigable, visible focus ring.
- Client i18n comes from `@/lib/i18n-runtime`, **not** `@/lib/i18n`.
- 375px: the per-division rows must stack rather than scroll the page.

- [ ] **Step 1: Write the failing tests** (`@testing-library/react`, follow `ai-console-frozen.test.tsx`)
1. `"pre-selects the predicted rung"`
2. `"selecting a lower rung shows the underfunded warning"`
3. `"selecting a higher rung shows no warning and raises the credit count"`
4. `"a single line renders no discount row"`
5. `"two lines show the batch discount row and the max(1, sum-1) total"` — two rung-1 divisions → total 1, discount 1.
6. `"the CTA names the credit count"` — `Run AI schedule — 5 credits`
7. `"the rung control is a keyboard-navigable radiogroup"`
8. `"agrees with quoteRun for the same lines"` — property-style: for several line sets, the rendered total equals `quoteRun(...).credits`. This is the test that catches a client/server pricing divergence.

- [ ] **Step 2: Run and watch fail**
- [ ] **Step 3: Implement the card, the picker, the reducer field, and the `rung` wiring in `ai-console.tsx`**
- [ ] **Step 4: Re-run green; then the whole board suite:**
```bash
npx vitest run src/components/v2/board
```
- [ ] **Step 5: Commit**

---

## Task 8: Un-gate the competition board

**Files:**
- Modify: `apps/web/src/components/v2/schedule-board.tsx` — `aiAvailable` at `:149`; the console mount at `:854-870`; `aiBrief` at `:155-172`
- Modify: `apps/web/src/app/o/[orgSlug]/c/[compSlug]/schedule/page.tsx` — it already computes the court union at `:100-106` and already passes `aiAllowed` at `:151`; it must additionally pass **per-division settings** so the console can build its quote lines and detect divergence.
- Create: `apps/web/src/components/v2/board/ai-competition-console.tsx`
- Test: `apps/web/src/components/v2/board/__tests__/ai-competition-console.test.tsx`

**Implementation notes:**
- `:149` currently reads `const aiAvailable = (canManage ?? canEdit) && single !== null && aiFlagOn;`. The `single !== null` clause is what disables multi mode. Replace with a form that allows `multi` when the competition console is available, keeping `single` for the existing per-division console.
- The multi console needs, per division: `id`, `name`, `seq`, `schedule_locked`, `courts`, movable-fixture count, entrant count. `page.tsx:100-106` already calls `getScheduleSettings` per division — reuse that pass rather than adding another.
- Division picker defaults to **all divisions with at least one movable fixture**. Fewer than 2 selected → the run CTA is disabled with the "use the division schedule page" hint, mirroring the server's 400.
- Court-divergence warning banner when the selected divisions' court labels are not identical, naming the divergent labels. Copy must say plainly that same-named courts are treated as the same court and differently-named ones are not.
- Result state colours proposed assignments per division and offers one joint Apply / Discard.

- [ ] **Step 1: Write the failing tests**
1. `"the AI button is disabled on a multi-division board without scheduling.multi_division"`
2. `"the AI console opens on a multi-division board when both features are on"` — the regression for `:149`.
3. `"the picker defaults to every division with movable fixtures"`
4. `"selecting one division disables the run CTA with the single-division hint"`
5. `"divergent court labels render the warning naming them"`
6. `"identical court labels render no warning"`

- [ ] **Step 2: Run and watch fail**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Re-run green; then `npx vitest run src/components/v2` and confirm the single-division board tests still pass**
- [ ] **Step 5: Screenshot-verify at 375px and at 1280px with Playwright; confirm no horizontal page scroll. Commit.**

---

## Task 9: i18n, help, smoke, e2e

**Files:**
- Modify: `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`
- Modify: the help page registry (find the AI-scheduling help slug; add a multi-division section)
- Modify: `scripts/smoke.ts` — the Pro-Plus two-phase happy path is at `:5092-5262`
- Modify: `apps/web/e2e/ai-architect.spec.ts` (helpers: `apps/web/e2e/helpers.ts`, fixture server: `apps/web/e2e/ai-fixture-server.ts`)

**Implementation notes:**
- Every string added in Tasks 7 and 8 needs a key in **all four** locales. Translate properly — do not paste English into `es`/`fr`/`nl`.
- Help pages are a mandatory closing pass on every branch. Document: credits buy a **token budget**, not usage; what the rung picker does; what "may stop before a full schedule" means; how joint pricing works (`Σ − 1`); and that shared courts are matched **by name**.
- Smoke: add a 2-division joint path asserting the breakdown price, plus the insufficient-balance path. Follow the existing Pro-Plus block's structure.
- e2e: board flow — picker → price → run → review → apply. Use `startAiFixtureServer`. **Never enable `.github/workflows/e2e.yml`** — it is disabled deliberately. Verify locally:
  ```bash
  npm run build --workspace apps/web
  E2E_PROD_TARGET=http://localhost:3100 npx playwright test e2e/ai-architect.spec.ts
  ```

- [ ] **Step 1: Add the en keys, then the es/fr/nl translations**
- [ ] **Step 2: `npm run i18n:gen-keys && npm run i18n:check`** — must exit 0 with no diff
- [ ] **Step 3: Help-page pass**
- [ ] **Step 4: Extend `scripts/smoke.ts`; run the full smoke locally and confirm green**
- [ ] **Step 5: Extend the e2e spec; run it locally against a prod build**
- [ ] **Step 6: Commit**

---

## Final verification (controller runs this, not a task)

```bash
npm run typecheck --workspace apps/web
npm run lint --workspace apps/web
npm run openapi:gen && git diff --exit-code openapi/
npm run i18n:gen-keys && npm run i18n:check && git diff --exit-code apps/web/src/lib/i18n-keys.ts
cd apps/web && DATABASE_URL=postgresql://postgres@127.0.0.1:54329/seazn_test \
  DATABASE_SSL=disable DB_SCHEMA=pr359 npx vitest run
```

Full `apps/web` suite baseline before this plan: **515 files, 4270 passing, 14 skipped**. `src/lib/__tests__/pass-scoping-guard.test.ts` is a known 5s-timeout flake under parallel load; it passes in isolation and is unrelated.

Then reopen PR #359.
