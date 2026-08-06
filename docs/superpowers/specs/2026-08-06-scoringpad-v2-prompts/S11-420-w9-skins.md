# S11 — #420 (W9): sport skins — cricket, racquet family, football

Paste this whole file as the session opener. Read `_RULES.md`, then `_INDEX.md`
(S10's chassis contract, S7's label keys), then this. UI-craft session.

Branch `feat/s11-w9-skins` in a fresh worktree. One PR. Issue #420.
Design: `../2026-08-03-scoringpad-v2-design.md` (Part II, "Universal renderer and skins").

Layout craft only — same PadSpec, same chassis dispatch, **no new events**. Flag
still off.

## Why

The universal renderer guarantees coverage, not ergonomics. A cricket scorer
thinks in overs and needs the over's rhythm on screen; a tennis scorer thinks in
points-within-games-within-sets; a football scorer needs the clock and two big
goal buttons. These three families carry the platform's real match volume — they
earn hand-crafted layouts. **Everything else stays on the universal renderer
deliberately.**

## Scope

1. **`scorepad/skins/cricket-skin.tsx`** — over-rhythm primary surface (this
   over's balls, extras drawer, dismissal flow with fielder attribution, free-hit
   state), innings header (score/wickets/overs, DLS par when `dls.enabled`),
   variant-aware from `padSpec(cfg)`: t20/odi/hundred/test panels, the hundred's
   ball structure honoured, follow-on and declaration where the variant allows.
2. **`scorepad/skins/racquet-skin.tsx`** — point-first layout (server marked,
   rally winner tap, ace/fault where the spec declares them), set/game
   scoreboard, tiebreak state, config-driven differences (best-of, points-to,
   golden point). **One skin serving tennis + volleyball + badminton +
   tabletennis.**
3. **`scorepad/skins/football-skin.tsx`** — clock + period control, goal/assist
   attribution flow, cards and subs drawers. Evaluate the period sports
   (icehockey, hockey) for reuse: if the period kernel's spec shapes match, one
   skin serves all three; otherwise football-only and the period pair stays on
   the universal renderer. **Record the decision in the PR body and `_INDEX.md`.**
4. **Skin registry contract** — a skin consumes `{padSpec, chassis}` and may
   render **only** actions the spec declares. **Skin-coverage test**: every skin
   reaches the same action set as the universal renderer for its sports ×
   variants (drive from S6's conformance fixtures). A skin hiding an action fails
   CI.
5. **i18n** ×4 for any skin-specific chrome; action labels keep coming from S7's
   `labelKey` dictionaries.

No dispatcher or route changes.

## Acceptance criteria

- [ ] Skin-coverage test green: cricket, racquet and football skins reach **every**
      spec action for **every** variant
- [ ] Cricket skin: a full over scored with extras **and** a fielder-credited
      dismissal in ≤ the tap count of v1 — count it, put the number in the PR
- [ ] Racquet skin serves all four racquet/net sports with correct config-driven
      differences (flipping best-of changes the scoreboard)
- [ ] Football skin: goal with assist attribution, a card, and a sub — each ≤ 3
      taps from the live surface
- [ ] Period-sport reuse decision made, justified, and recorded
- [ ] Skins render in **both** auth contexts (console + device link) with no
      layout drift
- [ ] Screenshots per skin at desktop **and 375px**, no horizontal page scroll,
      touch-sized targets — attached to the PR
- [ ] i18n ×4 green; `git diff --stat` confined to `scorepad/skins/` + registry +
      dictionaries
- [ ] Vitest counts from the JSON reporter; `tsc EXIT=0`; lint `✖ 0 problems`

### Test types

- **Unit / component** — per skin, per phase, per variant; the coverage test.
- **E2E (Playwright)** — drive each skin in a real browser at 375px through its
  headline flow (an over with a dismissal; a game to deuce; a goal with assist).
  If the flag is still off and no route reaches a skin, use the test harness
  route from S10 and say so in the PR body; the routed e2e lands in **S12**.
- **Smoke — deferred to S13.**
- **Regression** — a skin that omits a spec action must fail the coverage test
  (mutation-prove it: remove one action's render, watch it go red, restore from a
  `cp` backup).

## Gotchas

- **A skin inventing an event type or bypassing chassis dispatch is the failure
  mode this architecture exists to prevent.** The coverage test is the gate; the
  reviewer enforces the dispatch path.
- 375px is the primary scoring surface in the real world — design mobile-first;
  desktop is the adaptation.
- Load `frontend-design:frontend-design` **before** any skin work, not after:
  these three screens are the product's face on match day. Visual restyles beyond
  the brief need owner sign-off.
- Tap-count claims must be counted, not estimated. Put the actual number in the PR.
- UI text here will be e2e-anchored later — grep `e2e/` (both phases) for any
  string you reuse from v1.

## Execution

Three skins are **provably disjoint files** → parallel `implementer` agents are
correct here. The **skin-coverage test + registry land inline first**, so the
agents build against a gate that already exists. Then `reviewer` over the
combined diff, then the main thread reruns the gate.

**Scout (sonnet) brief:** S10's chassis hook surface and the renderer's dispatch
entry point; where S6's conformance fixtures live and how to drive them from a
component test; the existing v1 cricket/tennis/football pads' tap flows (for the
count comparison only). file:line table only, under 25 lines.

**Implementer brief (×3, one per skin)** carries: the skin's own file path,
"do NOT touch chassis, renderer, registry, or the other two skins", the chassis
hook signature pasted in full, the coverage-test command, the 375px-first rule,
and the output cap.

**Reviewer (sonnet):** does any skin dispatch outside the chassis? Does any skin
render an action the spec does not declare, or hide one it does? Are the
screenshots at both breakpoints and free of horizontal scroll? Gap list only.

## On close

`_INDEX.md`: S11 → DONE, the period-sport reuse decision, the tap counts, and any
skin left on the universal renderer on purpose. Memory + snapshot script.
