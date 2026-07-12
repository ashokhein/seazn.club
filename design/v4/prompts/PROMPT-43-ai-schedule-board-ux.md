# PROMPT-43 — AI Schedule Board UX: instruction panel, ghost preview, diff, accept, follow-up

**Read first:** `v4/00-ai-schedule-architect.md` §2/§7 (modes, failure copy),
`v4/01-llm-contract.md` §3 (plan shape); `components/v2/schedule-board.tsx` + `board/*`
(tray/panel patterns, `use-board-actions.ts` seq handling), `components/upgrade-gate.tsx`,
`lib/feature-copy.ts`; memory gotchas: board payload budget (v3/11 gap 15), tap-target
a11y (PROMPT-31 patterns). Preamble: PROMPT-00. **Depends:** PROMPT-41 (42 for follow-up
turns + competition board). Do not run alongside PROMPT-41/42.

## Task

1. **AI panel** (board right dock, mobile bottom sheet — same chrome as unscheduled tray):
   "AI schedule" pro-badged button in board header; panel = instruction textarea
   (3..4000, placeholder shows two example instructions), mode auto-derived (blank board →
   generate; proposal open → refine; "Repair" toggle exposes scope pickers: from
   datetime, courts multi-select, pools). Hidden entirely when kill-switch off; free orgs
   see `UpgradeGate feature="scheduling.ai"`.
2. **Run state**: optimistic spinner with stage text ("Packing board… Planning…
   Verifying…"); errors map v4/00 §7 copy (503/422/429/402) inline in panel, never toast-only.
3. **Ghost preview**: proposal renders as translucent blocks on the grid (distinct hue +
   dashed border) alongside current placements; unchanged fixtures dim; conflicts from
   `blocking` get the existing red corner tick. Diff strip: `moved / placed / unscheduled /
   unchanged` counts + list view grouped by change type with jump-to-fixture (reuse
   conflicts-panel jump). Explanations: info dot on ghost block → popover with the model's
   note; `summary` shown at top of panel.
4. **Accept / discard**: Accept = create `before-ai` checkpoint → apply (`source:"ai"`,
   `expected_seq` via existing seqRef) → if `constraint_suggestions` present, checked
   list "Also save these rules" applied via schedule-settings PUT → board refetch + toast
   with undo affordance. `SEQ_CONFLICT` → refetch + offer "Re-run as refine". Discard =
   `ai_plan_discarded` capture. Blocking assignments: accept button disabled until
   organiser unticks blockers (they drop to unscheduled tray on apply).
5. **Follow-up turn** (after PROMPT-42): proposal accepted or not, panel keeps a compact
   history of instructions this session; new instruction with proposal open posts
   `mode:"refine"` + `prior`. Competition board gets the same panel wired to the
   competition endpoint, ghosts across division lanes.
6. **A11y + mobile**: panel fully keyboard operable; ghost blocks focusable with change
   description in aria-label; 390px: sheet + agenda-mode diff list (no grid ghosts
   required, list is the preview).

## Acceptance

- E2E (mocked model) on seeded division: type instruction → ghosts + diff counts match
  payload; accept → board persists, checkpoint `before-ai` listed in history panel, undo
  restores pre-AI board; suggestion tick writes constraints (settings tab shows them);
  free org sees UpgradeGate (no network call); 429 renders inline copy; keyboard-only run
  → accept pass; 390px sheet flow completes.
- Unit: diff computation (moved/placed/unscheduled/unchanged) against fixture list;
  blocking-gate on accept button.
- smoke.ts: pro path drives panel run + accept via UI-level helper; free path asserts
  gate visible.
- No board initial-payload regression (gap 15 budget); `npm test` + `tsc` green; update
  v4/README status.
