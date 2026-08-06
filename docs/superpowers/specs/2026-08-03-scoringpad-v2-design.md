# #407 execution programme — eligibility, dates, formats, player stats, ScoringPad v2

Date: 2026-08-03. Covers **all four workstreams of #407** plus a greenfield
rebuild of the scoring pad. #407's body already records the confirmed product
decisions for WS1 (eligibility), WS3 (formats) and WS4 (dates); this document
does not re-litigate them — it adds what needed fresh design (the sport data
model audit and the pad), one integration decision that touches WS2, and the
wave structure that turns all of it into executable prompts.

Three scope rulings from the owner (2026-08-03):

1. The scoring pad is rebuilt **greenfield** — a new contract and a new
   component tree, not incremental patches to the eight v1 pads. #407 WS2
   step 6 (PAD_FOR registry consolidation) is superseded by that rebuild.
2. The programme covers everything in #407, not just the pad.
3. **Not only the UI layer.** The sport data model itself may not capture the
   full sport — cricket may lack fields for facts a real scorebook records,
   and the other ten sports are unaudited. Every sport's schema must be
   audited against the sport's real scoring domain, per variant, and extended
   where it falls short — then the pad must feed all of it.

## Part I — Workstreams lifted from #407 (decisions already confirmed)

These summaries exist so the wave prompts can cite one document; the
file-level step lists live in #407 and are repeated in the prompts.

**WS1 Eligibility enforcement.** Divisions declare age/gender rules but only
the public registration submit path enforces them; organiser entrant create,
roster add, patch, squad sync, CSV import, lineup submit and team-registration
confirm all bypass (#407 lists the seven gate points). Build shared
`usecases/eligibility.ts` + `usecases/audit.ts`, typed zod rule union, gate
all seven points with 422 `ELIGIBILITY_VIOLATION` + audited
override-with-reason (`competition_events` type `eligibility.overridden`),
missing dob/gender = warning not block (public submit keeps its stricter
behaviour), override dialog UI + amber warning chips. No migration.

**WS4 Date-constraint hardening.** Competition ⊇ division ⊇ schedule/fixture
dates, registration windows inside them. Migration V345 adds nullable
`divisions.starts_on/ends_on` (null = inherit competition window) + row-local
CHECKs; zod superRefines for order rules; `usecases/date-bounds.ts` with
`assertWithin`/`dateShrinkViolations`; shrink edits blocked 422
`DATE_OUT_OF_RANGE` with structured `violations[]`; `ScheduleConfig.endAt`
finally bounds the auto-scheduler via derived `horizonMinutes`;
ladder/americano divisions exempt from close-before-start (late join is by
design, warn only). Forms get min/max + violation rendering.

**WS3 Formats: qualification out of every stage kind.** Fix `StageKind` enum
drift (engine missing `americano`, `ladder`, `page_playoff`); teach
qualification to read bracket placements (`bracketRanks` → placement snapshot
written for every stage kind at completion), add `RoundLosers` spec (plate
brackets), americano qualifies by personal points, ladder by ladder order;
delete the `stages.ts:1192` "not supported yet" throw; new `ko_plate` and
`qualifying_main` templates; engine tests for americano/ladder/page-playoff
that don't exist today. No migration.

**WS2 Player stats for every sport + career rollup.** Engine stats core gains
dot-paths, computed values, entrant-attribution resolution
(`PlayerStatsFoldCtx.personsOf`), folded models; kernel-level default models
(setbased/nested) cover volleyball/badminton/tabletennis/tennis at once;
per-sport models for cricket, boardgame/chess, carrom, generic; server
recompute resolves lineup entrants → persons; `/me` career section groups by
sport; public player card rollup stays competition-scoped (consent posture
unchanged). Read-side projection only — no migrations, snapshots
self-backfill via recompute-on-read.

**New integration decision (modifies WS2 step 3):** the audit wave (Part II)
adds optional explicit PersonId fields to event schemas. Stat fold models must
**prefer explicit person fields when a payload carries them and fall back to
`personsOf(entrantId)`** otherwise. Stats keep working for v1-era events and
get sharper as v2 pads emit attribution. Consequence for ordering: schema
extensions land before the stat models.

## Part II — Sport data completeness + ScoringPad v2 (greenfield)

### Problem

The requirement: **feed all available data per sport per variant**. That fails
at two layers today, and both are in scope:

**Layer 1 — the data model.** Whether a sport's schemas can even represent
what a real scorebook records is unverified. Cricket's config is rich
(`CricketCfgBase`: DLS, follow-on, super over, per-result points…) but whether
the ball event carries dismissal-mode detail, fielder credit on catches and
run-outs, the extras breakdown, free-hit state, or review outcomes is exactly
what an audit must establish — and cricket is the *best* case; the other ten
modules have never been checked against their sport's laws. Additionally the
entrant-only families (setbased/nested/boardgame/carrom/generic) cannot
attribute events to persons at all, which is why 8 of 11 sports show
`requires_detailed_scoring` instead of player stats.

**Layer 2 — the UI.** Eight hand-written pads
(`apps/web/src/components/v2/pads/*-pad.tsx`) each expose the subset of
`eventSchema` their author thought of; nothing checks coverage. Two drifting
dispatchers (`fixture-console.tsx:226-231,~316`,
`device-score-pad.tsx:59-63,268-283`) plus a third hardcoded key list
(`scoring-vocab.ts:15-17`). Variants are config presets (`sport_variants`,
org-custom rows since V203) but resolved config barely reshapes the UI: a
`hundred` innings, a `superOver`, `dls.enabled`, best-of — none change what
the scorer sees. Pre-match facts (toss, serve order, colour, lineup confirm)
and post-match facts (`postDecisionTypes`, result confirmation) have no home.
Offline is 3 in-memory retries (`device-score-pad.tsx:107-135`); tab death
courtside loses the queue.

The completeness chain this programme builds, each link enforced:

```
sport reality  ⊇-audited  eventSchema/Cfg  ⊇-conformance  PadSpec  ⊇-rendered  pad UI
```

### What already exists and is kept untouched

Scouted 2026-08-03. The substrate is complete: `score_events` hash-chained
ledger with gapless `seq`, `core.void` undo and `device_link_id` rider
(V216/V222); `match_states` fold cache + `seq-{last_seq}` ETag (V217); append
path `POST /api/v1/fixtures/[id]/events` `{expected_seq, type, payload,
idempotency_key}` → `scoreEvent` (`usecases/scoring.ts:81`) →
`resolveModule(sport_key, module_version)` → `appendEvent`, 409 SEQ_CONFLICT +
`since_seq` resync; Supabase realtime channel `fixture:{id}` with entitlement
gate and 15s polling fallback; device links (account-less, fixture-scoped,
sha256, EOD expiry, `/score/[token]`); `SportModule<Cfg,Ev,State>` semver
registry pinned per division; lineups, entrant members, officials,
availability, suspensions already loaded by the console. Richer events are a
**payload shape** change only — `score_events.payload` is jsonb, so no ledger
migration ever. Legacy V014 `matches` (flat chess columns) is dead v1-baseline
weight — out of scope; chess is the `boardgame` module.

### The sport domain audit (Layer 1)

Per sport, per variant, a **domain dossier** at
`packages/engine/src/sports/<key>/DOMAIN.md`:

1. Enumerate the sport's scorable facts from its laws and standard scorebook
   conventions — events, participants-in-event, states, configuration knobs —
   per declared variant (t20 vs test differ; blitz vs classical differ).
2. Map every fact to its schema path (`Cfg`/`Ev`/`State`/`summary`/`metrics`),
   or classify it: **gap → extend now** (additive optional fields/branches,
   minor version bump) or **deferred** (with the reason stated — niche,
   unscorable at our fidelity, needs product decision).
3. Extend the schemas for the "extend now" class, update fold/summary so new
   events change state meaningfully, keep divisions pinned to older versions
   folding (additive-only rule), regenerate conformance streams.

Person attribution is one class of audit gap: optional PersonId fields (`by`,
`assist`, event-specific participants) across the entrant-only families.

The conformance kit asserts every builtin module ships a `DOMAIN.md`
containing a mapping table, so "audited" is a checkable property; the *truth*
of a dossier is established once by owner review of the audit PR, then guarded
by review whenever schemas change.

### Approaches considered for the pad (Layer 2)

**A. Hand-crafted per-sport v2 pads on a shared chassis.** Best bespoke UX;
but coverage stays a manual promise, 11 sports of UI to maintain, every new
sport/variant means new pad work. Rejected: v1's failure mode with nicer
plumbing.

**B. Pure schema-generated pad.** Derive UI mechanically from `eventSchema`
introspection. Guaranteed coverage, zero per-sport code; but introspection
cannot express scoring ergonomics (an over's rhythm, tennis point flow) —
every sport gets a lowest-common-denominator form. Rejected: coverage without
usability loses the scorer.

**C. Contract + skins (chosen).** Each module declares a **PadSpec** —
declarative description of its scoring surface, conformance-tested for
bidirectional coverage against the (now audited) `eventSchema` per variant.
One universal renderer executes any PadSpec; marquee sports add skins that
consume the same actions/state but own their layout. Coverage becomes a
CI-enforced property; UX stays craftable where it matters; a new sport is
scoreable the day its module lands with zero web-side work.

### The PadSpec contract

`padSpec` is a new `SportModule` field, a **pure function of resolved config**
so variants naturally reshape the surface:

```ts
padSpec(cfg: Cfg): PadSpec   // cfg = base ⊕ variant preset ⊕ org overrides
```

PadSpec is data only (engine purity gate: no React, no display strings that
bypass i18n):

- **phases** `pre` / `live` / `post` — pre-match panels capture setup events
  (toss, serve order, colour, lineup confirm); post-match panels surface
  `postDecisionTypes` and result confirmation.
- **panels** — named, ordered action groups with layout hints (`primary`,
  `grid`, `drawer`, `perSide`), optionally gated on predicates over folded
  `state`/`summary` (a super-over panel appears when reachable).
- **actions** — each maps 1:1 onto an `eventSchema` union branch: event
  `type`, parameter fields (enums/numbers/toggles) with bounds derived from
  `cfg` (`ballsPerOver`, best-of…), an attribution requirement
  (`none | side | person(role?) | persons(n)`), and a stable `labelKey`
  resolved through the existing scoring-vocab i18n pattern.
- **fidelity tiers** — ~~which panels/actions belong to `quick` (result-only),
  `standard` (structured events), `full` (everything, person-attributed)~~
  **SUPERSEDED 2026-08-06 by S2/#430** (ruling in
  `2026-08-06-scoringpad-v2-prompts/_INDEX.md`). There is no
  `quick`/`standard`/`full` — that vocabulary was invented here and never
  existed in the code. The fidelity ladder is the **numeric `FidelityTier.tier`, 0–3**,
  already declared at `packages/engine/src/sport/module.ts:63-67` and already
  read by the paywall at `apps/web/src/server/usecases/fidelity.ts:17-29` (free
  floor `tier <= 1`). `padSpec` tiers ARE that number; minting a second name for
  it would require a permanent translation table whose drift means a free org
  pressing a paid button. **The fidelity ladder is closed at 0–3 — there will never be a
  tier 4.** Note when reading any module: tier 3 is a byte-identical duplicate
  of tier 2 in 7 of 8 module files; **cricket alone** (`cricket.ts:2392-2401`)
  has a real four-band fidelity ladder, and it is the correct model.

**Conformance.** For every builtin module and **every declared variant**:
(a) every `eventSchema` union branch is reachable from some action — the full
tier hides nothing; (b) every action generates payloads `eventSchema` accepts
(property-generation across parameter bounds); (c) label keys unique and
stable; (d) tiers nest — asserted by iterating **adjacent members of the
module's declared `fidelityTiers` array**, never as hardcoded pairs, so a module
declaring only 0 and 1 (carrom) exercises the same assertion as one declaring
0–3; (e) `DOMAIN.md` present.
A module without a complete padSpec fails CI.

### Chassis

New tree `apps/web/src/components/v2/scorepad/`. Headless core first:

- **Pipeline** — append with `expected_seq` + `idempotency_key`, 409 → resync,
  optimistic local fold using the module's fold (engine is pure, runs in the
  browser), reconcile on server state.
- **Offline queue** — pending events in IndexedDB keyed by `idempotency_key`,
  survives tab death, replays in order renegotiating `expected_seq`; visible
  queue depth and an explicit "offline — keep scoring" state. Hash chain stays
  server-side; the client preserves only order + idempotency.
- **Timeline** — full event list, `core.void` undo, void+re-append correction,
  per-event attribution display.
- **Attribution picker** — lineup-aware person chips (squad number, position)
  honouring PadSpec requirements; side-only fallback when no roster exists,
  never blocking the action.
- **Contexts** — both auth modes (authed console, device-link token) and both
  transports (realtime channel, polling fallback).
- **Variant resolution** — division's pinned `module_version` + variant key +
  org overrides resolved into the `cfg` handed to `padSpec(cfg)`; the pad
  renders the **pinned** module's spec, never latest.

### Universal renderer and skins

The renderer walks PadSpec: phase navigation, panels as button grids/forms
sized for courtside use, fidelity switcher (tier per fixture; mid-match
upgrade allowed, downgrade warns), i18n via dictionary keys with engine label
fallback, 375px-first. Skins for cricket, the racquet family (tennis +
setbased share one skin, config-driven differences) and football replace
**layout only**: same PadSpec, same chassis dispatch, may not invent events —
a skin-coverage test asserts each skin reaches the same action set. Sports
without a skin get the universal renderer and are fully scoreable.

### Rollout

One registry (`scorepad/registry.tsx`) feeds **both** entry points, killing
the dual dispatcher. v2 sits behind a feature flag through integration (both
routes, e2e green, screenshots desktop + 375px); cutover flips the default,
deletes the v1 pads, ships help pages and smoke coverage. No parallel-forever.

### Non-goals

No ledger table/append-API/auth/entitlement changes. No standings changes. No
org custom-variant *editor* UI (variants resolve; editing is a follow-up). No
video/photo capture, no scorer chat, no service worker (IndexedDB queue only).
Deferred dossier lines are explicitly out of scope until a follow-up issue
picks them up.

## Part III — Waves

| Wave | Scope | Depends on |
|---|---|---|
| W1 | Eligibility enforcement: shared usecase, 7 gates, override dialog (WS1) | — |
| W2 | Date hardening: V345, zod refines, date-bounds, scheduler `endAt`, forms (WS4) | W1* |
| W3 | Formats: enum drift, placement snapshots, qualification from every kind, templates (WS3) | — |
| W4 | Sport domain audit: DOMAIN.md ×11, schema extensions, attribution fields | — |
| W5 | PadSpec contract + conformance coverage, all 11 modules | W4 |
| W6 | Player-stat models: stats core, kernel + per-sport models, prefer-person-fields (WS2 eng) | W5† |
| W7 | Career rollup: server plumbing, `/me` career, public card scope (WS2 web) | W6 |
| W8 | Pad chassis + universal renderer (flag off) | W5 |
| W9 | Sport skins: cricket, racquet family, football | W8 |
| W10 | Integration behind flag: one registry, both entry points, offline e2e | W9 |
| W11 | Cutover: default on, delete v1 pads, help + smoke + polish | W10 |

\* W1→W2 is file-overlap sequencing (`schemas.ts`, `registrations.ts`), not a
logical dependency. † W6 logically needs only W4 (attribution fields), but
W5/W6 both edit every module file and the conformance kit — chained to avoid
the same-file parallel trap.

Safe parallel groups (provably disjoint file sets): {W1→W2} ∥ {W3} ∥
{W4→W5→W6} at programme start; after W6: {W7} ∥ {W8→W9→W10→W11}. Rebase at
wave boundaries only. Each wave is one PR.

## Programme-wide gates

Every wave: tests that fail without the change; vitest judged only via
`--reporter=json --outputFile` counts; lint via `rtk proxy`; api-v1 schema
changes → `npm run openapi:gen` + commit (drift gate is CI-only); new
user-facing strings in all 4 dictionaries (help pages stay English-only); UI
screenshot-verified at desktop and 375px; engine waves keep
`scripts/engine-boundary.ts` green; each wave lands as its own PR (smoke CI
runs on PRs only).
