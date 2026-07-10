# Jul3/04 — Scheduling Constraints v2 & AI-Assisted Planning

Extends the calendar pass ([05-formats-progression-tiebreakers.md](../05-formats-progression-tiebreakers.md)
§2.6) and the scheduling console (doc 12, PROMPT-17) with the constraint family organisers
keep asking for, plus a natural-language planning assist. Design only.

## 1. Motivation & scope

- **Cross-category player clash** (22 May; 8 Jun; 29 Jun) — a player in two teams across
  categories must not be scheduled twice at once; today the clash detector only works
  *within* one category, and duplicate-name players in different categories aren't linked.
- **Min break / no back-to-back** (4 Jun ×1; 14 Apr; 20 Oct) — "at least one break between a
  team's matches"; different break per group/division (20 Oct).
- **Per-team / per-group start windows** (14 Apr; 10 May) — "team XY no earlier than 9:30
  even if the tournament starts at 8:00"; category starts later for logistics.
- **Fair field distribution** (14 Apr) — don't dump one team on field 4 all day; alternate
  fields.
- **Block vs mixed scheduling** (29 May) — divisions play in parallel, not whole slots
  reserved for one division.
- **Bulk time shift** (10 Jun ×1; 5 Sep ×3; 26 Jun ×1) — push all pitches back 15 min at
  once; postpone all courts.
- **No fixed times mode** (26 Sep ×3; 9 Jun; 8 Dec) — flexible/self-scheduled long-running
  events.
- **Min/max wait reporting** (16 Sep ×3) — surface the worst rest/wait a team faces.
- **AI planning** (29 Jun) — natural-language constraints ("no player plays two teams at
  once, spread breaks evenly") that compile into the solver.

**In scope:** a richer `SchedulingConstraints` spec, the person-link that makes
cross-category clash work, solver objective additions, bulk-shift + no-fixed-time modes,
wait-time diagnostics, and an AI layer that *only* emits validated constraint objects. **Out:**
the solver core rewrite — this extends the existing greedy+repair pass, doesn't replace it.

## 2. The cross-category link (root cause of the #1 clash complaint)

The 22-May report: same person entered under two categories as two name strings; the
in-division clash check never links them. The v2 model already has org-scoped `persons`
(doc 02 §3) — the fix is to make clash detection operate on **person identity across
divisions**, not name strings:

```ts
// built once per competition from entrant_members ⋈ persons (doc 07)
PersonScheduleMap = Map<personId, { entrantId, divisionId }[]>
```

The calendar pass already accepts sibling-division assignments + a person→entrant map for
overlap warnings (doc 05 §2.6, PROMPT-17 §3). This doc makes that map **competition-wide and
person-keyed**, and promotes cross-division person overlap from `warn` to a configurable
`hard` constraint. No schema change — it's a query + a policy flag.

## 3. Constraint spec (types-first, validated by the solver)

```ts
SchedulingConstraints = z.object({
  restMin:        z.number().int().optional(),      // min minutes between a team's fixtures
  restByGroup:    z.record(z.string(), z.number()).optional(),  // per pool/division (20 Oct)
  noBackToBack:   z.boolean().default(false),       // ≥1 fixture gap (4 Jun)
  startWindows:   z.array(z.object({                // per team/group/division (14 Apr, 10 May)
                    target: z.object({ kind: z.enum(['entrant','pool','division']), id }),
                    notBefore: z.string().optional(), notAfter: z.string().optional() })).default([]),
  fieldFairness:  z.enum(['off','balance','rotate']).default('off'),  // 14 Apr
  parallelism:    z.enum(['block','mixed']).default('mixed'),         // 29 May
  crossPersonClash: z.enum(['warn','hard']).default('warn'),          // §2
  sessionWindows: z.array(z.object({ start, end, courtIds })).default([]), // existing
  blackouts:      z.array(z.object({ courtId, start, end })).default([]),  // existing
});
```

Solver additions (all soft unless marked hard; the pass stays greedy-place → local-repair,
never silently drops — doc 05 §2.6):
- `restMin`/`noBackToBack` → hard reject placements violating rest; repair by shifting.
- `startWindows` → hard lower/upper bound per target.
- `fieldFairness` → soft objective: minimise per-team court-count variance (`balance`) or
  force round-robin over courts (`rotate`).
- `parallelism=mixed` → allow different divisions in the same slot (removes the "whole slot
  reserved for one division" behaviour).
- `crossPersonClash=hard` → treat person double-booking like a court clash.

## 4. Bulk shift, no-fixed-time, wait diagnostics

- **Bulk shift** (10 Jun / 5 Sep / 26 Jun): `shiftSchedule({scope, deltaMinutes})` — pure
  transform over selected fixtures' `scheduled_at`; scope = all / court / division (mirrors
  the scoped-clear filters, Jul3/03 §5). One `division_events: schedule_shifted`, undoable
  (Jul3/03). Solves "push everything back 15 min" and "postpone all courts."
- **No-fixed-time mode**: division flag `scheduling_mode = 'timed' | 'flexible'`. Flexible
  divisions generate fixtures with `scheduled_at = null`, ordered but not clock-slotted;
  public schedule shows order + "not yet scheduled"; results still record. Covers
  club-ladder / multi-week events (26 Sep, 8 Dec) — pairs with the ladder format
  (Jul3/08).
- **Wait diagnostics** (16 Sep): pure `scheduleReport(assignments) → { perEntrant: {minGap,
  maxGap, maxWait}, worst: [...] }` shown in the console before publish — no schema, a
  derived read model.

## 5. AI-assisted planning (29 Jun)

A thin, **safe** layer — the model never touches the DB or invents a schedule; it only
translates prose into the validated `SchedulingConstraints` object, which the deterministic
solver then honours:

```
organiser prose ──▶ LLM (tool-constrained) ──▶ SchedulingConstraints (Zod-validated)
                                              └▶ rejected if it fails schema/eligibility
constraints ──▶ engine calendar pass (pure) ──▶ proposal + conflicts (organiser approves)
```

- The LLM output is parsed by the *same* Zod schema (§3); anything unparseable is refused,
  not guessed. Determinism/audit unaffected — the schedule still comes from the pure solver.
- Use the latest Claude model via the Anthropic SDK; server-side only; the prompt is the
  constraint schema + a few examples. This is the one place an LLM enters the engine
  surface, and it stays advisory (proposes constraints, human applies).
- Entitlement `scheduling.ai` = Pro/Business.

## 6. API & entitlements

- `PUT /api/v1/divisions/{id}/schedule-settings` gains the §3 fields (extends doc 12 §4).
- `POST /api/v1/schedule/shift` (bulk), `GET /api/v1/divisions/{id}/schedule/report`.
- `POST /api/v1/divisions/{id}/schedule/ai-constraints` (prose → constraints, propose only).
- Entitlements (extends doc 10 `scheduling.constraints` Pro): `restMin`/`startWindows`/
  `fieldFairness`/`crossPersonClash=hard` under `scheduling.constraints` (Pro); bulk shift +
  wait report = all plans; `scheduling.ai` = Pro.

## 7. Edge cases

- Over-constrained instance (no feasible schedule) → solver returns best-effort +
  `conflicts[]` listing which constraints couldn't be met; never fabricate an invalid slot.
- `startWindows` + rest together can be infeasible → report the binding constraint.
- Cross-person clash needs `persons` linked; unlinked duplicate names still `warn` (the
  merge/link path is Jul3/01 §4 person matching / doc 08 persons-merge).
- Flexible-mode fixtures excluded from court/rest solving (no clock) but still counted for
  cross-person "can't be in two live matches" once a result is being entered.
