# 06 — Divisions, Age Groups & Eligibility

What makes "U16 cricket T20" different from "U18 cricket ODI" in design terms — and why
none of it belongs in the sport module.

## 1. The three orthogonal axes

A division = **who may play** × **which rules variant** × **how it progresses**:

| Axis | Examples | Owned by |
|------|----------|----------|
| **Eligibility** (who) | U16, U19, Open, Women, Mixed, A-grade | eligibility engine (this doc) |
| **Sport variant** (rules) | T20 vs ODI, beach vs indoor, blitz vs classical | sport module Cfg (doc 04) |
| **Format** (progression) | group+KO, league, swiss | stage graph (doc 05) |

Cricket example: a club "Summer Carnival 2026" Competition might carry divisions
`U16 Boys · T20 · group+KO`, `U19 Boys · T20 · group+KO`, `Open · ODI · league`,
`Women · T20 · league`. **Same sport module**, three configs, independent fixtures,
standings and rosters — but shared venue calendar and one public dashboard.

Age and variant *correlate* in the real world (youth football plays shorter halves;
U13 cricket plays fewer overs) — the model keeps them separate and lets a **division
template** bundle them: `template "U16 T20" = {eligibility: U16, variant: t20,
overrides: {maxOversPerBowler: 4}}`. Governing bodies' junior regulations become
shippable templates, not code.

## 2. Eligibility rules

```ts
EligibilityRule =
  | { kind: 'age',    maxAgeAt?: number, minAgeAt?: number, cutoff: {month, day, yearOf: 'season_start'|'calendar'} }
  | { kind: 'gender', allowed: ('m'|'f'|'x')[] }        // or mixed-with-composition, later
  | { kind: 'grade',  allowed: string[] }               // org-defined grading labels
  | { kind: 'roster', maxSize?, minSize?, maxPerFixture? }
  | { kind: 'custom', note: string }                    // documented manual rule; UI warns, doesn't block
Division.eligibility: EligibilityRule[]                 // AND-combined
```

### 2.1 Age computation — the critical subtlety
"Under 16" means **under 16 on a cutoff date**, and the cutoff differs by body:
ICC youth uses Sep 1 (England) / varies by board; most football bodies use Jan 1 of the
season year; school sport uses academic-year dates. So the rule is *always explicit*:
`U16 = { maxAgeAt: 15, cutoff: {month: 9, day: 1, yearOf: 'season_start'} }` reading
"15 or younger on Sep 1 of the season-start year". `age = wholeYearsBetween(dob, cutoffDate)`.
Never compute from "today".

### 2.2 Enforcement points (soft by default, hard for Pro locks)
1. **Roster add** — person's DOB/gender checked against division rules ⇒ block or
   organiser-override with reason (override recorded as division event; visible on audit).
   Missing DOB ⇒ warning state, listed on a "compliance" panel.
2. **Lineup submit** — re-check (person may age across a long season only if cutoff-based
   rule says so — cutoff rules are stable all season, which is exactly why cutoffs exist).
3. **Cross-division play** — allowed by default ("playing up": a U16 may play U19/Open);
   `playDown: forbidden` by default. Config per competition.

## 3. Grades (A/B, Division 1/2)

Grades are org-defined labels on divisions plus optional **promotion/relegation links**
between successive competitions: `division.promotion = {up: divisionRef?, down?, count}`.
v2 stores the link and surfaces "promoted/relegated" on final standings; automated
carry-over into next season's entrant list is a later workflow.

## 4. Design/development consequences (the user's actual question)

What genuinely changes per axis — checklist for implementers:

1. **Schema**: divisions are first-class (doc 07); `entrants`, `stages`, `fixtures`,
   `standings` all hang off `division_id`, never off competition. Persons are shared
   org-wide, rosters are per-division ⇒ one child can appear in U16 *and* Open with
   different squads, kits and stats.
2. **Engine**: zero age logic in sport modules. Modules see config values (20 overs, 30-min
   halves) that a template *derived* from an age rule. Keeps modules testable and rules
   auditable.
3. **Scheduling**: divisions share venues/courts ⇒ the calendar pass (doc 05 §2.6) takes
   fixtures from *all* divisions of a competition when checking conflicts; per-person
   conflicts matter for players rostered in two divisions (warn on overlap).
4. **Standings/stats**: always division-scoped. Cross-division aggregates ("club
   championship" points across divisions) = a Competition-level view, Pro feature (doc 10).
5. **Public dashboard**: division switcher is a primary navigation axis (doc 09).
6. **Entitlements**: Community = 1 division per competition; multi-division is Pro (doc 10).
7. **Data protection**: youth divisions imply minors ⇒ per-division privacy flags
   (hide DOB always; photo/full-name display opt-in per person via `persons.consent`
   fields; public dashboard shows initials when consent absent). This is a legal
   requirement, not a feature — build it into the public read model from day one.
