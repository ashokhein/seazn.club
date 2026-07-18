# Entrant Shapes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sport modules declare what an entrant looks like (kinds, roster caps, captain/№ relevance); organisers override per division; the entrants UI and write path obey the effective model.

**Architecture:** A pure `effectiveEntrantModel(module?, divisionConfig?)` resolver in the engine merges module declaration ← division `config.entrants` override; both the server write path and the client panel consume it (client imports of engine pure fns are established practice — slideshow.tsx). No DB migration: the override rides the existing untyped `divisions.config` channel.

**Tech Stack:** TypeScript, zod (web schemas), vitest (engine + apps/web from `apps/web` cwd), postgres.js test suites gated on `DATABASE_URL` (local test DB `postgresql://postgres@127.0.0.1:54329/seazn_v13`).

## Global Constraints

- Kind caps are STRUCTURAL: individual=1, pair=2 — config can never change them (spec §2).
- Existing entrant rows are never revalidated; validation applies to writes only (spec §5).
- Modules without `entrantModel` keep today's behaviour: all kinds allowed, default `individual`, team affordances on (spec §1).
- Error codes: 422 `ENTRANT_KIND_NOT_ALLOWED`, 422 `ENTRANT_ROSTER_TOO_BIG`, 422 `ENTRANT_KIND_IN_USE` (settings guard) — HttpError only, NOT the engine EngineError enum (that is a 3-touch closed enum; these are API-level).
- Every code change ships a test that fails without it; run web vitest from `apps/web` cwd.
- i18n: any new console copy lands in en/fr/es/nl ui.json + `npm run i18n:gen-keys` + `npm run i18n:check`.
- Help pages updated in the same branch (closing task).

---

### Task 1: Engine — entrant model types, resolver, module declarations

**Files:**
- Create: `packages/engine/src/sport/entrant-model.ts`
- Modify: `packages/engine/src/sport/module.ts` (add `entrantModel?` field, ~line 96 next to `playerStats?`)
- Modify: `packages/engine/src/sport/index.ts` (re-export) — check existing export style first (`grep -n "export" packages/engine/src/sport/index.ts`)
- Modify: module declarations: `packages/engine/src/sports/football/football.ts` (team), `cricket` (team), `hockey` (team), `icehockey` (team), `boardgame` (individual), `carrom` (individual+pair), `tennis` (individual+pair). `generic` gets NONE (legacy fallback proof).
- Test: `packages/engine/src/sport/entrant-model.test.ts`

**Interfaces:**
- Produces (everything later tasks import from `@seazn/engine/sport`):

```ts
export type EntrantKind = "team" | "individual" | "pair";
export interface EntrantModel {
  kinds: EntrantKind[];
  defaultKind: EntrantKind;
  team?: { squadNumbers: boolean; captain: boolean; minMembers?: number; maxMembers?: number };
}
export interface EffectiveEntrantModel {
  kinds: EntrantKind[];
  defaultKind: EntrantKind;
  squadNumbers: boolean; // team-kind affordance
  captain: boolean;      // team-kind affordance
  maxTeamMembers: number | null;
}
export function effectiveEntrantModel(model?: EntrantModel | null, divisionConfig?: unknown): EffectiveEntrantModel;
export function entrantKindCap(kind: string, eff?: Pick<EffectiveEntrantModel, "maxTeamMembers">): number;
```

- [ ] **Step 1: failing tests** — `packages/engine/src/sport/entrant-model.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { effectiveEntrantModel, entrantKindCap } from "./entrant-model.ts";
import { football } from "../sports/football/index.ts";
import { boardgame } from "../sports/boardgame/index.ts";

describe("effectiveEntrantModel", () => {
  it("legacy fallback without a model: all kinds, individual default, team affordances on", () => {
    const eff = effectiveEntrantModel(null, undefined);
    expect(eff.kinds).toEqual(["team", "individual", "pair"]);
    expect(eff.defaultKind).toBe("individual");
    expect(eff.squadNumbers).toBe(true);
    expect(eff.captain).toBe(true);
    expect(eff.maxTeamMembers).toBeNull();
  });
  it("module defaults: football is team-only with numbers+captain", () => {
    const eff = effectiveEntrantModel(football.entrantModel);
    expect(eff.kinds).toEqual(["team"]);
    expect(eff.defaultKind).toBe("team");
    expect(eff.squadNumbers).toBe(true);
  });
  it("module defaults: boardgame is individual-only", () => {
    const eff = effectiveEntrantModel(boardgame.entrantModel);
    expect(eff.kinds).toEqual(["individual"]);
  });
  it("division override widens kinds and flips affordances", () => {
    const eff = effectiveEntrantModel(boardgame.entrantModel, {
      entrants: { kinds: ["individual", "team"], captain: false, squadNumbers: false },
    });
    expect(eff.kinds).toEqual(["individual", "team"]);
    expect(eff.captain).toBe(false);
  });
  it("garbage config is ignored field-by-field", () => {
    const eff = effectiveEntrantModel(football.entrantModel, { entrants: { kinds: "nope", defaultKind: 7 } });
    expect(eff.kinds).toEqual(["team"]);
    expect(eff.defaultKind).toBe("team");
  });
  it("caps are structural", () => {
    expect(entrantKindCap("individual")).toBe(1);
    expect(entrantKindCap("pair")).toBe(2);
    expect(entrantKindCap("team")).toBe(Number.POSITIVE_INFINITY);
    expect(entrantKindCap("team", { maxTeamMembers: 26 })).toBe(26);
  });
});
```

- [ ] **Step 2:** `cd packages/engine && npx vitest run src/sport/entrant-model.test.ts` → FAIL (module not found).
- [ ] **Step 3: implement** `packages/engine/src/sport/entrant-model.ts`:

```ts
// Entrant shapes (spec 2026-07-18): what an entrant of a sport/kind looks
// like. Module declaration ← division config.entrants override, merged
// field-by-field; structural caps are not configurable.
const ALL_KINDS = ["team", "individual", "pair"] as const;
export type EntrantKind = (typeof ALL_KINDS)[number];

export interface EntrantModel {
  kinds: EntrantKind[];
  defaultKind: EntrantKind;
  team?: { squadNumbers: boolean; captain: boolean; minMembers?: number; maxMembers?: number };
}

export interface EffectiveEntrantModel {
  kinds: EntrantKind[];
  defaultKind: EntrantKind;
  squadNumbers: boolean;
  captain: boolean;
  maxTeamMembers: number | null;
}

const isKind = (v: unknown): v is EntrantKind => ALL_KINDS.includes(v as EntrantKind);

export function effectiveEntrantModel(
  model?: EntrantModel | null,
  divisionConfig?: unknown,
): EffectiveEntrantModel {
  const base: EffectiveEntrantModel = {
    kinds: model?.kinds?.length ? [...model.kinds] : [...ALL_KINDS],
    defaultKind: model?.defaultKind ?? (model?.kinds?.[0] ?? "individual"),
    squadNumbers: model?.team ? model.team.squadNumbers : true,
    captain: model?.team ? model.team.captain : true,
    maxTeamMembers: model?.team?.maxMembers ?? null,
  };
  const raw = (divisionConfig as { entrants?: Record<string, unknown> } | null | undefined)?.entrants;
  if (!raw || typeof raw !== "object") return base;
  const kinds = Array.isArray(raw.kinds) ? raw.kinds.filter(isKind) : [];
  if (kinds.length > 0) base.kinds = kinds;
  if (isKind(raw.defaultKind) && base.kinds.includes(raw.defaultKind)) base.defaultKind = raw.defaultKind;
  if (!base.kinds.includes(base.defaultKind)) base.defaultKind = base.kinds[0]!;
  if (typeof raw.squadNumbers === "boolean") base.squadNumbers = raw.squadNumbers;
  if (typeof raw.captain === "boolean") base.captain = raw.captain;
  return base;
}

/** Structural caps; a team cap comes from the model's maxMembers when set. */
export function entrantKindCap(
  kind: string,
  eff?: Pick<EffectiveEntrantModel, "maxTeamMembers">,
): number {
  if (kind === "individual") return 1;
  if (kind === "pair") return 2;
  return eff?.maxTeamMembers ?? Number.POSITIVE_INFINITY;
}
```

- [ ] **Step 4:** add to `SportModule` interface in `packages/engine/src/sport/module.ts` (import type from `./entrant-model.ts`):

```ts
  // Entrant shapes (2026-07-18 spec): allowed kinds + team affordances.
  // Absent = legacy behaviour (all kinds, team affordances on team rosters).
  entrantModel?: EntrantModel;
```

- [ ] **Step 5: module declarations.** In each sport module object (next to `positions:`):
  - football/cricket/hockey/icehockey: `entrantModel: { kinds: ["team"], defaultKind: "team", team: { squadNumbers: true, captain: true } },`
  - boardgame: `entrantModel: { kinds: ["individual"], defaultKind: "individual" },`
  - carrom, tennis: `entrantModel: { kinds: ["individual", "pair"], defaultKind: "individual" },`
  - Check each module file's export site with `grep -n "positions" packages/engine/src/sports/<sport>/<sport>.ts`.
- [ ] **Step 6:** re-export from the sport barrel: check `packages/engine/src/sport/index.ts` (or wherever `PlayerStatsModel` is exported from — `grep -rn "PlayerStatsModel" packages/engine/src/sport/index.ts`) and mirror it for `entrant-model.ts`.
- [ ] **Step 7:** `cd packages/engine && npx vitest run src/sport/entrant-model.test.ts` → PASS; then full `npx vitest run` → 884+ pass (module-shape additions must not break conformance suites).
- [ ] **Step 8:** commit `feat(engine): entrantModel declarations + effectiveEntrantModel resolver`.

### Task 2: Server write validation

**Files:**
- Modify: `apps/web/src/server/usecases/entrants.ts` (createEntrants + the PATCH/update path — locate with `grep -n "export async function" apps/web/src/server/usecases/entrants.ts`)
- Test: extend `apps/web/src/server/usecases/__tests__/entrants.test.ts` (existing file; check its seeding helpers first)

**Interfaces:**
- Consumes: `effectiveEntrantModel`, `entrantKindCap` from `@seazn/engine/sport`; `resolveModule` from `@/server/engine-db`.
- Produces: private helper inside entrants.ts:

```ts
async function assertEntrantShape(tx: Tx, divisionId: string, kind: string, memberCount: number): Promise<void>
```

- [ ] **Step 1: failing DB test** (in the existing describe.skipIf(!DATABASE_URL) suite; reuse its org/division seeding helpers — read the file top first):

```ts
it("entrant shapes: boardgame rejects team kind and >1 member (G-entrant-shapes)", async () => {
  // Seed a boardgame division via the suite's createDivision helper with
  // sport_key "boardgame" and its minimal config (copy the suite's existing
  // boardgame/chess config if present; else use the generic seeding pattern
  // with sport_key "boardgame", variant "standard").
  // 1) kind not allowed:
  await expect(
    createEntrants(owner, division.id, [{ kind: "team", display_name: "Blunders FC", members: [] }]),
  ).rejects.toMatchObject({ status: 422, code: "ENTRANT_KIND_NOT_ALLOWED" });
  // 2) roster too big for individual:
  await expect(
    createEntrants(owner, division.id, [
      { kind: "individual", display_name: "Two Heads", members: [m1, m2] }, // two person_ids
    ]),
  ).rejects.toMatchObject({ status: 422, code: "ENTRANT_ROSTER_TOO_BIG" });
  // 3) division override widens kinds:
  await sql`update divisions set config = config || ${sql.json({ entrants: { kinds: ["individual", "team"] } })} where id = ${division.id}`;
  const ok = await createEntrants(owner, division.id, [{ kind: "team", display_name: "Allowed Now", members: [] }]);
  expect(ok[0]!.kind).toBe("team");
});
```

- [ ] **Step 2:** run → FAIL (no validation yet). `cd apps/web && DATABASE_URL=postgresql://postgres@127.0.0.1:54329/seazn_v13 npx vitest run src/server/usecases/__tests__/entrants.test.ts`
- [ ] **Step 3: implement** in entrants.ts — load once per createEntrants call (not per row):

```ts
import { effectiveEntrantModel, entrantKindCap } from "@seazn/engine/sport";
import { resolveModule } from "@/server/engine-db";

async function loadEntrantShape(tx: Tx, divisionId: string) {
  const [d] = await tx<{ sport_key: string; module_version: string; config: unknown }[]>`
    select sport_key, module_version, config from divisions where id = ${divisionId}`;
  if (!d) throw new HttpError(404, "division not found");
  let model = null;
  try {
    model = resolveModule(d.sport_key, d.module_version).entrantModel ?? null;
  } catch {
    // retired module build — legacy shape
  }
  return effectiveEntrantModel(model, d.config);
}
```

Then in createEntrants (and the members-replacing PATCH path) before insert:

```ts
const eff = await loadEntrantShape(tx, divisionId);
for (const input of inputs) {
  const kind = input.kind ?? eff.defaultKind;
  if (!eff.kinds.includes(kind as never)) {
    throw new HttpError(422, `this division doesn't take '${kind}' entrants`, "ENTRANT_KIND_NOT_ALLOWED");
  }
  const cap = entrantKindCap(kind, eff);
  if ((input.members?.length ?? 0) > cap) {
    throw new HttpError(422, `a ${kind} entrant holds at most ${cap} ${cap === 1 ? "person" : "people"}`, "ENTRANT_ROSTER_TOO_BIG");
  }
}
```

PATCH path: when `members` present, recheck count against the ENTRANT's kind; when `kind` present, recheck allowed.
- [ ] **Step 4:** run test → PASS. Full entrants suite → PASS (legacy divisions unaffected because generic has no model → all kinds).
- [ ] **Step 5:** commit `feat(entrants): write-path validation against the effective entrant model`.

### Task 3: Division Settings — Entrants block (+ kind-in-use guard)

**Files:**
- Modify: `apps/web/src/components/v2/division-settings.tsx` (new Group after the format section; follow the existing `Group title=... summary=...` pattern at ~line 503)
- Modify: `apps/web/src/server/usecases/divisions.ts` update path — guard: rejecting a kinds override that orphans existing entrants
- Modify: division console page (`apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx`) — pass the effective model + module default down to DivisionSettings (server-resolve, serialize plain object)
- Test: `apps/web/src/components/v2/__tests__/division-settings-entrants.test.tsx` (markup, mock next/navigation + confirm provider like `stages-panel-delete.test.tsx`), plus one DB test in divisions.test.ts for the 422 guard
- i18n: `divset.entrants.*` keys ×4 locales + gen-keys

**Interfaces:**
- Consumes: `EffectiveEntrantModel` (plain object prop `entrantModel`), existing division PATCH (`apiV1 PATCH /api/v1/divisions/{id}` with `{ config: { entrants: {...} } }` merge semantics — VERIFY how the PATCH merges config: `grep -n "config" apps/web/src/server/usecases/divisions.ts | head`; if it replaces wholesale, send the full merged config from the client as the wizard does).
- Produces: settings UI writing `config.entrants`; server 422 `ENTRANT_KIND_IN_USE`.

- [ ] **Step 1: failing markup test** — renders the block from props:

```tsx
// division-settings-entrants.test.tsx
it("shows sport defaults and allows widening kinds", () => {
  const html = renderSettings({ entrantModel: { kinds: ["individual"], defaultKind: "individual", squadNumbers: false, captain: false, maxTeamMembers: null } });
  expect(html).toContain("Entrants");
  expect(html).toContain("individual");
  // checkboxes for the other kinds render unchecked but present
  expect(html).toContain("team");
  expect(html).toContain("pair");
});
```

- [ ] **Step 2:** server guard test (divisions.test.ts): create division, add a team entrant, PATCH config.entrants.kinds=["individual"] → 422 `ENTRANT_KIND_IN_USE`; withdraw the entrant → PATCH succeeds.
- [ ] **Step 3: implement UI** — checkbox row per kind, default-kind select (options = ticked kinds), captain/№ toggles visible only while `team` ticked, "Sport default" caption when `config.entrants` absent, Reset button clearing the override (PATCH config.entrants = null). Reuse `.input/.label`, Group/danger patterns already in the file.
- [ ] **Step 4: implement guard** in divisions update usecase: when the incoming config narrows `entrants.kinds`, `select distinct kind from entrants where division_id=... and status not in ('withdrawn','disqualified')`; any kind outside the new list → `throw new HttpError(422, "entrants of kind '<k>' already exist — withdraw them first", "ENTRANT_KIND_IN_USE")`.
- [ ] **Step 5:** run both tests → PASS; tsc; commit `feat(divisions): Entrants settings block with sport defaults + in-use guard`.

### Task 4: Entrants panel adapts (folds the parked working-tree edits)

**Files:**
- Modify: `apps/web/src/components/v2/entrants-panel.tsx` — the parked edits already gate RosterEditor captain/№ on `teamish` and hide the picker at cap; KEEP them, replace the local `entrantKindCap` copy with the engine import, wire `kind` from `entrant.kind`, and rework `NewEntrantFields`.
- Modify: division console page — pass the serialized `entrantModel` prop into EntrantsPanel.
- Test: extend `apps/web/src/components/v2/__tests__/entrant-badge-control.test.tsx` file? NO — new file `apps/web/src/components/v2/__tests__/entrants-panel-shapes.test.tsx` (markup; RosterEditor is already exported from the parked edits).

**Interfaces:**
- Consumes: `entrantKindCap`, `EffectiveEntrantModel` from `@seazn/engine/sport` (client import precedent: slideshow.tsx imports engine).
- Produces: `EntrantsPanel` new prop `entrantModel: EffectiveEntrantModel`; `RosterEditor` props `{ kind: string; allowCaptain: boolean; allowSquadNumbers: boolean }` (replace the bare `teamish` guess with model-driven flags: `teamish = kind === "team"`, captain shown when `teamish && allowCaptain`).

- [ ] **Step 1: failing markup tests** (RosterEditor + NewEntrantFields exported):

```tsx
it("individual roster: no captain, no squad number, no picker at cap", () => {
  const html = renderRoster({ kind: "individual", members: [oneMember], allowCaptain: true, allowSquadNumbers: true });
  expect(html).not.toContain("captain");
  expect(html).not.toContain('placeholder="No."');
  expect(html).not.toContain("Find player…");
});
it("team roster with captain disabled by config hides the checkbox", () => {
  const html = renderRoster({ kind: "team", members: [oneMember], allowCaptain: false, allowSquadNumbers: false });
  expect(html).not.toContain("captain");
  expect(html).toContain("Find player…");
});
it("add form: single allowed kind hides the select; individual hides the name field", () => {
  const html = renderAddForm({ kinds: ["individual"], defaultKind: "individual" });
  expect(html).not.toContain(">Kind<");
  expect(html).not.toContain(">Name<");
  expect(html).toContain("Search players…");
});
```

- [ ] **Step 2: implement NewEntrantFields:** kind state initialised to `entrantModel.defaultKind`; kind `<select>` renders only `entrantModel.kinds` and is hidden when length is 1; when kind is individual → no Name input, picker caps at 1 (clicking a second person REPLACES the pick), submit sends `display_name = persons.find(p=>p.id===memberIds[0]).full_name`; pair → picker caps at 2 (block further picks), Name input auto-fills `"A & B"` from the two picks while the user hasn't typed (track `nameTouched` flag), still editable; team → unchanged. On kind change, slice memberIds to the new cap.
- [ ] **Step 3: RosterEditor final shape:** props `kind`, `allowCaptain`, `allowSquadNumbers`; `teamish = kind === "team"`; № input shown when `teamish && allowSquadNumbers`; captain shown when `teamish && allowCaptain`; picker hidden at `members.length >= entrantKindCap(kind, entrantModel)`.
- [ ] **Step 4:** wire the division page: resolve module server-side (same resolveModule try/catch as Task 2), `effectiveEntrantModel(...)`, pass as plain prop.
- [ ] **Step 5:** tests PASS + tsc + full v2 component suite.
- [ ] **Step 6:** commit `feat(entrants): kind- and sport-aware add form + roster editor`.

### Task 5: Closing — smoke, help, i18n, gates

**Files:**
- Modify: `scripts/smoke.ts` (extend v13Suite or add entrantShapes block near the existing badge checks ~line 3306)
- Modify: `apps/web/content/help/entrants/kinds.md` (document sport defaults + the settings override)
- i18n keys from Tasks 3–4 already ×4; re-run gen-keys + check.

- [ ] **Step 1: smoke** — in the existing admin/org context: create a boardgame division via API; POST a 2-member individual entrant → expect 422; POST 1-member individual → 201 and `display_name` echoes; PATCH division config.entrants widening kinds → team POST 201. Follow the file's `check(...)`/`v1(...)` idioms.
- [ ] **Step 2: help** — kinds.md gains a paragraph: sports now preset their entrant shape; Settings → Entrants overrides; individual/pair caps.
- [ ] **Step 3: gates** — `cd apps/web && npx tsc --noEmit` 0; full web vitest; engine vitest; local smoke run (`node scripts/smoke.ts` against the dev server per the repo's smoke README — reuse the smoke DB + port 3014 recipe from memory).
- [ ] **Step 4:** commit `feat(entrants): smoke + help + i18n closing pass`, push branch `feat/entrant-shapes`, open PR.

## Self-Review

- Spec §1 → Task 1; §2 resolver → Task 1; §3 settings + guard → Task 3; §4 panel → Task 4; §5 validation → Task 2; §6 tests distributed per task; smoke → Task 5. No gaps.
- Type consistency: `EffectiveEntrantModel` prop name `entrantModel` used in Tasks 3–4; `entrantKindCap(kind, eff?)` signature identical in Tasks 1/2/4.
- Placeholder scan: verification greps are explicit commands, not TBDs. Clean.
