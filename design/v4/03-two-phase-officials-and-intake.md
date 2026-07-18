# v4/03 — Two-phase architect: officials + guided intake (2026-07-18 revision)

Normative amendment to `00`/`01`/`02`, approved in brainstorm 2026-07-18. Extends the AI
Schedule Architect into a **two-phase matchday architect**: Phase A plans times/courts
(corpus pipeline unchanged), Phase B assigns officials to the dry-run schedule with the
same draft→plan→referee pattern. Adds the guided intake for infrequent users, repair
nudges, and the AI audit trail. Competition-level multi-division planning (00 §4, second
endpoint of PROMPT-42) is **deferred** to a follow-up wave.

New prompts allocate **PROMPT-85..87** (84 = v16 closing pass; 44..47 taken by v5). They
implement 00/01/02 as amended by this doc; the original 41..43 files remain the base
reference and are not built verbatim.

## §0 Drift fixes vs the 2026-07-12 corpus (binding)

| Corpus said | Reality now | Fix |
|---|---|---|
| `scheduling.ai` = Pro (00 §6) | Moved to **Pro Plus** in V290 (with `officials.auto`) | Gate copy + `UpgradeGate` → PlusReveal disclosure; 402 copy from `feature-copy.ts` |
| No officials in pack (01 §2) | Officials system rich since v11/#115: `role_keys`, blackouts, cross-org busy-elsewhere, `max_per_day`, entrant links; pure `assignOfficials` engine with conflict taxonomy | Phase B (this doc §2–§3) + officials availability in Phase A pack |
| Model contract (01 §1) | Verified current 2026-07-18: `claude-opus-4-8`, `messages.parse` + `zodOutputFormat`, `thinking:{type:"adaptive"}`, `output_config.effort:"high"`, system `cache_control` ephemeral | Ship as written |
| Courts = settings strings | v15 venue corpus (designed, NOT built) will add `venue_courts` + `fixtures.venue_court_id` | Keep `court_label` strings; pack builder is the single seam to swap when v15 lands — note in code comment, no schema hedging |

## §1 Architecture — two phases, one pattern

```
PHASE A  buildSchedulePack(+officials availability) → slotFixtures draft → LLM
         → validateAssignments referee → ≤2 repairs → schedule proposal + coverage preview
                          organiser reviews ghost board ↓
PHASE B  buildOfficialsPack(dry-run times) → assignOfficials draft → LLM
         → officials-conflict referee → ≤2 repairs → officials proposal
                          organiser reviews officials grid ↓
ACCEPT   checkpoint before-ai → applySchedule(source:"ai") → applyOfficialAssignments
         → ledger events carry {instruction, summary}
```

Both phases: **solver drafts, LLM plans, engine referees** — the LLM is never trusted for
legality. Phase B referee = pure engine check over proposed `FixtureOfficial[]` using the
existing conflict taxonomy (`official_overlap`/`team_ref_self`/`role_unfilled` block;
`pool_leak`/`fairness`/`travel` warn) plus official blackouts and busy-elsewhere windows.
Zero engine change: `assignOfficials` takes injected epoch-ms fixture times, so dry-run
times slot straight in. Official blackouts and busy-elsewhere windows are not engine
inputs — the LLM gets them in the pack as hard rules and the server supplement (decision
8) enforces them on the proposal; the solver draft may violate them, which is exactly
what the LLM+referee pass is for.

Phase B is independently useful: called without a dry-run schedule it runs against current
DB times — instruction-driven officials assignment ("senior refs on finals") as a
standalone feature.

Stateless conversation both phases (00 §8.2): client posts `prior` back for refine; no
sessions table.

## §2 API surface (all registered in ROUTES)

### Phase A — `POST /api/v1/divisions/{id}/schedule/ai-plan`

Corpus 00 §4 / 01 §2 shape with three additions:

1. Pack gains `officials[]`: `{id, name, role_keys, max_per_day, blackouts[],
   busy_elsewhere[], entrant_ids}` (sorted, deterministic). Soft context only.
2. System prompt gains one soft goal (priority after fairness): *"prefer slots where each
   required role has an eligible, free official; name coverage risks in summary."*
   Golden-test updated verbatim.
3. Body gains optional `officials_policy?: AssignPolicy`. When present, response gains
   `officials_coverage: {fillable, total, unfilled:[{fixture_id, role_key}]}` — server
   runs a quick `assignOfficials` dry pass over the proposal with that policy. Absent →
   `officials_coverage: null` and the UI hides the coverage strip. No LLM tokens either
   way.

### Phase B — `POST /api/v1/divisions/{id}/officials/ai-plan` (new)

```jsonc
// body
{
  "instruction": "",                 // 0..2000; empty = solver draft + sensible spread
  "schedule": [{ "fixture_id": "…", "scheduled_at": "…", "court_label": "…" }], // optional dry-run; omit = current DB times
  "policy": { /* existing AssignPolicy zod */ },
  "prior": { "instruction": "…", "assignments": [ /* refine turn */ ] }          // optional
}
// response
{
  "assignments": [{ "fixture_id": "…", "official_id": "…", "role_key": "…", "locked": false }],
  "conflicts":   [ /* OfficialConflict — engine taxonomy, blocking flagged */ ],
  "diff": { "changed": [], "unchanged": [], "unfilled": [{ "fixture_id": "…", "role_key": "…", "reason": "…" }] },
  "explanations": [], "summary": "…",
  "usage": { "input_tokens": 0, "output_tokens": 0, "repair_rounds": 0 }
}
```

LLM output = strict zod `AiOfficialsPlan`: every required role slot appears exactly once
(assigned or in `unfilled` with a short reason). Locked rows echoed untouched — the
referee rejects any move of a locked assignment. Prompt module: new sibling in
`schedule-ai-prompt.ts`, verbatim + golden-tested like Phase A.

### Accept — no new endpoints

Client sequence: existing `POST /stages/{id}/schedule/apply` (`source:"ai"`,
`expected_seq`) → existing `POST /divisions/{id}/officials/apply`. If the officials apply
fails after the schedule applied: schedule stays, toast "officials not saved — review
tray". No distributed transaction; the `before-ai` checkpoint covers schedule undo.

### Removal + keeps

PROMPT-41 removal inventory unchanged (00 §1): `aiConstraintsForDivision` + route + ROUTES
row + parked UI in `constraints-panel.tsx` + its tests. Keep `scheduling.ai` key,
`ai-scheduling` PostHog kill-switch, `SCHEDULING_AI_MODEL` env, `@anthropic-ai/sdk`.

### Gates + limits

| Surface | Gate (all Pro Plus post-V290) | Rate limit |
|---|---|---|
| Phase A | `scheduling.ai` | `ai-plan:{divisionId}` 5/h (existing) |
| Phase B | `officials.auto` (+ `officials.roles_multi` when `policy.roles > 1`) | `ai-officials:{divisionId}` 5/h |

Check order per corpus 00 §6: auth → kill-switch → feature gate → rate limit → validation.

**Admin override (no new code, documented + tested):** per-org grant/kill of
`scheduling.ai` / `officials.auto` already works via `/admin/orgs/[id]` →
`POST /api/admin/orgs/[id]/entitlement-override` — `org_entitlement_overrides` resolves
*before* the plan matrix (with expiry), the route busts the entitlement cache and logs the
staff action. A smoke asserts: override grants a community org Phase A (200 not 402);
override with `bool_value:false` kills it for a Pro Plus org. The PostHog `ai-scheduling`
kill-switch stays the separate global off-switch.

## §3 Board UX — four-step console

Right dock desktop / bottom sheet at 390px (unscheduled-tray chrome). Persistent stepper
`Brief → Schedule → Officials → Apply`. Carries the 02 contract: 3-colour state palette
(amber moved / teal verified / red flagged), referee trace as first-class stepper+console,
summary-names-the-cost, blocks carry code+matchup+time only, `prefers-reduced-motion`
dumps the trace instantly.

**Step 1 — Brief (the infrequent-use fix).**
- *Pre-flight card*: live rows of what the AI will see — courts, session windows,
  blackouts, constraints set, movable fixtures, officials roster + availability coverage,
  pinned count. Each row ✓ or ⚠ with a deep link ("No session windows — AI assumes any
  time is fine. Set windows →"). Warnings never block the run.
- *Wish chips* compile into the instruction textarea (still editable): `finish by [time]`
  · `[pool/entrant] before/after [time]` · `keep [X] and [Y] apart` · `final last on
  [court]` · `pin [entrant's] slots`. Chips are copy + pickers — no new API. Mode chips +
  presets from 02 §4 stay.
- *Last AI run* strip (from ledger, §4): date + instruction; tap to refill.

**Step 2 — Schedule.** 02 verbatim: pipeline stepper, mono console, red flag pulse, ghost
board, diff/explanations, summary card with usage row. Adds *coverage strip* from
`officials_coverage` ("Officials: 14/16 slots coverable ⚠ 2"). CTAs: `Looks good →
Officials` / `Skip officials` (→ Apply).

**Step 3 — Officials.** Same referee-trace pattern over an officials grid (fixture rows ×
role chips with official avatars). Blocking conflicts red, warns amber. Officials wish
chips (`senior refs on finals` · `spread duties evenly` · `[official] only [window]`) +
instruction box + refine turn. Locked assignments padlocked and untouchable.

**Step 4 — Apply.** Both summaries + constraint-suggestions checklist (checked by
default, 00 §8.6) + `Apply schedule + officials` / `Apply schedule only` / `Discard`.
Applied board flips teal; checkpoint banner `before-ai`.

**Repair nudges.** Board derives disruption signals client-side from data it already has:
scheduled fixture inside a (new) blackout · `court_label` no longer in `courts[]` ·
fixture outside every session window · postponed-status fixtures with slots. Amber banner
"N fixtures need repair — Fix with AI" opens the panel in repair mode with scope
pre-filled. No polling, no new API.

**Mobile 390px.** Ghost grid → agenda diff list (02 §8.2); trace collapsible; chips wrap;
stepper compresses to dots. Screenshot-verify desktop + 390px is mandatory wave-wide.

## §4 Data + audit trail

- **One migration** (number at build; V-numbering contention — check shared dev DB
  first): extend `fixtures.schedule_source` check `none|auto|manual` → `+ ai`. Nothing
  else.
- `schedule_applied` ledger payload gains `{source:"ai", instruction, summary, model,
  repair_rounds}`; `officials_assigned` payload gains the same when AI-driven.
  Instruction trimmed to 500 chars. Payload is jsonb — no migration.
- *Last-run recall*: latest `schedule_applied` with `payload->>'source' = 'ai'` via the
  existing ledger query family. No new table.
- Auto-checkpoint `before-ai` in the accept flow (existing `schedule.versioning`).

## §5 Failure modes + telemetry

Corpus 00 §7 table stands. Additions:

| Condition | Response |
|---|---|
| Phase B, zero officials in roster | 422 `NO_OFFICIALS` + "add officials →" link (pre-flight warns first) |
| Phase B `role_unfilled` blocking on some fixtures | Accept allowed for filled ones; unfilled stay manual (mirror of Phase A blockers-to-tray) |
| Officials apply fails after schedule apply | Schedule kept; toast + tray link |
| Any error | Rendered inline in the active panel step, never toast-only (02 §7) |

PostHog: `ai_plan_run` gains `phase: "schedule"|"officials"`; `ai_plan_accepted` /
`ai_plan_discarded` as corpus; new `ai_repair_nudge_shown` / `ai_repair_nudge_clicked` /
`ai_preflight_gap_fixed`. Kill-switch `ai-scheduling` covers both phases.

## §6 Testing

1. **Pack snapshots** — schedule pack (with officials section) + officials pack;
   deterministic ordering; ≤60K-token budget test on the 500-fixture golden pack.
2. **Legality harnesses** (mocked Anthropic) — Phase A: court clash → repair round →
   clean (corpus 01 §6.2). Phase B: official overlap + locked-row move → referee catches
   both → repair → clean, `repair_rounds: 1`.
3. **Instruction cases** (mocked) — finish-by-18:00; pinned fixture untouched; senior
   refs on finals (role targeting); locked official survives all modes.
4. **Golden prompts** — both system prompts verbatim-tested; edits break the test.
5. **Routes** — ROUTES coverage test; 402 per gate; 429; 409 flexible; 422
   `NO_OFFICIALS`; admin override grants community org 200 / kills Pro Plus org 402.
6. **House rules** — failing-without-it regression per change; `scripts/smoke.ts` wave
   suite: pro path plan→officials→apply→ledger payload asserted, free path 402. Live
   `AI_EVAL=1` smoke opt-in, CI-excluded.
7. **UI e2e** — stepper rail; nudge banner appears when a blackout is injected over a
   scheduled fixture; chips compile into the textarea; apply flips the board teal.
   Screenshot-verify desktop + 390px.

## §7 Decisions (append to 00 §8)

7. **Two phases, two endpoints, stateless** — schedule and officials are separate
   propose-only calls; the client carries both proposals; accept chains the two existing
   apply rails. No joint time+official optimization (coverage-aware Phase A mitigates).
8. **Phase B referees with the existing taxonomy** — no new *engine* conflict kinds;
   locked rows are inviolable. The engine validates a locked set only for
   overlap/self-ref/pool-leak, so the server referee adds a thin web-side supplement:
   kind `ineligible` (block) for wrong-role / maxPerDay / official-blackout /
   busy-elsewhere breaches, checked in the use-case, engine untouched. Slots the LLM
   declares `unfilled` that the solver *can* fill come back as a warn with the solver's
   candidate ("lazy unfilled").
9. **Officials availability is soft context in Phase A** — never a hard rule; the engine
   referee stays the only authority on legality.
10. **Pre-flight warns, never blocks** — data gaps are links, not gates.
11. **Repair nudges are client-derived** — no server disruption detection, no polling.
12. **Audit lives in ledger payloads** — no new tables; recall reads the ledger.

## §8 Deferred

- Competition-level multi-division ai-plan (00 §4 second endpoint) — follow-up wave.
- Streaming referee trace (02 §8.3) — only if p95 latency hurts.
- Venue-aware packs — when v15 executes; pack builder is the seam.
