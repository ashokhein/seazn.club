# PROMPT-50 — Hockey UX + Ops: PeriodPad, strength on live surfaces, discipline stats, seed

**Read first:** `v6/00-sport-expansion-spec.md` §5 (normative), `v6/01-rules-digest.md`
§2/§3; `components/v2/pads/football-pad.tsx` (closest pad — mine its patterns, then
prefer the shared kernel shapes), `fixture-console.tsx` + `device-score-pad.tsx`
(dispatch), `components/public-site/live-score.tsx` + `/live` wall + slideshow (scorebug
surfaces), `scripts/seed-demo.ts`, demo-richness + smoke house rules. Preamble: PROMPT-00. **Depends:** PROMPT-49.

## Task

1. **PeriodPad** (`components/v2/pads/period-pad.tsx`), shared `icehockey`/`hockey`
   driven by module config (no sport-key branching inside the pad):
   - Goal flow: side tap → optional sub-sheet (scorer, assists ×2 for ice, goal kind:
     PP/SH/PS for ice, FG/PC/stroke for FIH) — sub-sheet skippable (fidelity tiers).
   - Penalty/card flow: class picker from `SuspensionCfg` (2/4/5/10/GM/MP vs
     green/yellow/red), person picker, active-suspension list with release action +
     wall-clock countdown hint (display only — fold trusts events).
   - Period controls: advance (P1→P2→…, quarter labels for FIH), OT entry, shootout
     recorder (alternating attempts, early-out indicator, sudden-death pairs).
   - Strength chip (5v4 / 5v3 / 10v11) always visible while suspensions active.
   - Register both dispatch points under a `PERIOD` set (football stays on FootballPad
     this wave; migration noted as follow-up).
2. **Live surfaces**: scorebug rows + `/live` wall + slideshow render period/phase
   (`P3`, `Q4`, `OT`, `GWS/SO`) and strength chip from `summary.detail`; headline
   grammar per v6/00 §5 (`2 — 1 · P3`, `(GWS 2–1)`, `(SO 3–2)`); public fixture page
   shows goals-by-period table + discipline list.
3. **Stats & reports**: player stats surfaces gain G/A/P + PIM (ice) and cards (FIH)
   from module metrics; division "discipline" report tab (PIM leaderboard / card list,
   FIH escalation flags) on the existing report patterns; PC-conversion stat on FIH
   division stats.
4. **Officials UX**: role presets from PROMPT-49 appear in officials panel defaults for
   the new sports (referee×2+linesman×2 / umpire×2); assignment flows unchanged.
5. **Seed + demo** (v6/00 §5): pro org — icehockey division with OT game, GWS game, 5v4
   PP goal; tennis already seeded by 48; community org — FIH division with a draw and
   green+yellow cards. Demo-richness rule: individual/team entrants + fixtures +
   results present.
6. **i18n note** (v6/00 §6.7): strings via v5 `console`/`public` namespaces if landed,
   else inline with `// v5-i18n` markers for the ratchet.

## Acceptance

- E2E (390px device pad + console): score an icehockey game — two minors overlapping
  shows 5v3 chip, PP goal recorded with assists, minor released early on PP goal
  (scorer-driven release), OT sudden-death goal ends game, GWS flow records 5+SD
  attempts; FIH game — quarter advances, green then yellow on same player shows
  escalation hint, team-short chip 10v11, drawn game finalizes as draw in standings.
- E2E (public): live scorebug shows `· P3` + strength chip while suspension active;
  fixture page renders goals-by-period + discipline list; slideshow unaffected at
  1080p.
- Unit: pad-level strength/countdown derivation from suspension events; headline
  grammar snapshots for all phases; discipline report aggregation.
- smoke.ts: pro path drives one PP goal + release via pad helper; free path views live
  scorebug with strength chip.
- axe pass on PeriodPad (keyboard: goal, penalty, release all operable); no board
  payload regression; `npm test` + `tsc` green; update v6/README status — wave
  complete.
