# v4/02 — Schedule board UX (design + prototype finding)

Normative-lite reference for **PROMPT-43**. Sharpens the loosely-worded bits of the prompt
(“distinct hue”, “translucent blocks”, “stage text”) into a fixed visual + interaction
contract, and records what an interactive prototype changed our mind about. Read with
`prompts/PROMPT-43-ai-schedule-board-ux.md` (the task list) and `00 §2/§7`, `01 §3`.

> **Prototype (2026-07-14):** a faithful, mocked-LLM prototype of this surface exists —
> local `scratchpad/v4-ai-schedule-architect.html`, published artifact
> `https://claude.ai/code/artifact/0cb1aa2d-8779-4c3c-8832-ec26155bc483`. It drives all
> three modes (generate / refine / repair) against hand-authored plans, animates the
> pipeline, and exercises the diff/accept flow. It is a **design mock, not wired** — no
> real `messages.parse`, no `applySchedule`. Use it as the pixel + motion reference; the
> findings below are the parts worth carrying into code.

---

## §0 Finding — the referee round is the product, so show it

PROMPT-43 treats verification as plumbing (blocking fixtures get “the existing red corner
tick”). Building the surface flipped that: **the draft → plan → referee → repair loop is the
single most convincing thing on the screen** — it is the visible proof of the binding
decision *“the LLM plans, the engine referees.”* An organiser about to hand scheduling to an
AI does not trust a black box that returns a finished grid; they trust one they watched get
**caught and corrected**.

So promote the pipeline from a spinner (“Packing board… Planning… Verifying…”, PROMPT-43 §2)
to a **first-class, always-shown trace**, even on the happy path:

1. A **stepper** — `Draft · Plan · Referee · [Repair ×n] · Ready` — nodes light in sequence;
   the Referee node turns **red** when `validateAssignments` returns blocking conflicts and a
   Repair node appears, then both settle to verified-green.
2. A **console** (mono) streaming the real machine events, e.g.
   `verify › validateAssignments → FLAG court_overlap: SF2 × SF1 @ Court 1 · 13:00`
   then `repair › round 1 → move SF2 → Court 1 · 14:00 (minimal)` then `→ CLEAN · 0 blocking`.
3. On a flag, the **conflicting fixtures pulse red on the grid** for ~1.5s before the repair
   round slides them to their fixed slot — the audience sees the catch *and* the fix.

On a clean run (0 repairs) the trace still shows `validateAssignments → CLEAN · 0 blocking`.
The safety mechanism becomes the headline, at the cost of ~2–4s of orchestrated motion — so
it is fully gated behind `prefers-reduced-motion` (dump the trace instantly, land on the
final board).

**Decision (binding for 43):** the verifier/repair loop is surfaced, not hidden. The
happy-path “CLEAN” line ships too — absence of conflicts is itself the reassurance.

---

## §1 Colour contract (binding)

Three hues, each carrying one meaning — semantic, not decorative. They map to the domain and
must be reused verbatim wherever the AI surface renders diff/verify state (board ghosts, diff
list, stepper, console emphasis).

| Token (proposal) | Meaning | Where |
|---|---|---|
| **floodlight / amber** | *your instruction / the AI’s plan* — a **moved** fixture, the thing the AI changed | ghost blocks that moved, `moved` diff group, mode/preset accents |
| **court / teal** | *engine-verified legal* — a newly **placed** fixture, and any **accepted/applied** block | placed ghosts, verified stepper nodes, `0 blocking` chip, applied board |
| **flag / red** | *conflict caught by the referee* — a **blocking** fixture or an in-flight repair flag | flagged fixtures during repair, `blocking` diff group, verifier FLAG line |

Unchanged fixtures stay in the neutral panel colour (dimmed under a proposal, per 43 §3).
This is separate from the accent used on marketing/chrome; it is a **state palette**. Keep
the amber/teal/red legible on both board themes — verify contrast on the light board.

## §2 Layout anatomy (reference: prototype)

- **Organiser console** (board right dock; mobile bottom sheet — same chrome as the
  unscheduled tray): division summary → mode chips (`generate / refine / repair`) →
  instruction textarea (3..4000, placeholder = two example instructions) → **one-tap example
  presets** (see §4 finding) → `Plan schedule` / `Reset`.
- **Pipeline card** appears on run: stepper (§0.1) + console (§0.2) + `state: running|done`.
- **Board**: courts × time grid, ghost proposal over current placements (43 §3).
- **Result** (below board, two columns): **Summary** card (model `summary` at top, usage row,
  constraint-suggestion opt-in, `Accept & apply` / `Discard`) + **“Why it did that”** card
  (the explanations / diff list).

## §3 Fixture block — what goes on it (finding)

The prototype first tried an in-block move caption (`was Court 2 · 13:30`). **It does not
fit** — a 30-minute match is one grid slot (~40px tall); a block holds only a code row
(`SF2` + time + a `JR` pill) and a one-line matchup. So:

- **Decision:** block carries **colour + code + JR/Final marker + matchup + time** only.
  Move-provenance (`was Court 2 · 13:30`) lives in the **diff list / explanations**, never on
  the block. Enforce a **≥40px** block min-height for legibility; ellipsize the matchup.
- Final and junior fixtures get a persistent marker (left-border tint / `JR` chip) that is
  independent of diff colour, so “this is the final” survives regardless of whether it moved.

## §4 Instruction input (finding)

A bare textarea under-performs — organisers hesitate on *what to type*. The prototype added
**explicit mode chips** and **one-tap example presets** per mode; this carried the “say what
you want” promise far better than placeholder text alone.

- **Decision:** ship mode chips (`generate/refine/repair`) **and** 2–3 seeded example
  instructions the organiser can tap to fill the box (e.g. generate: *“Wrap up by 6pm,
  juniors before 2pm, final last on Court 1.”*; repair: *“Court 2 flooded from 1pm — move
  everything off it.”*; refine: *“Move the final to the last slot.”*). Presets are copy, not
  new API.
- Stateless conversation confirmed sufficient: a **session-local instruction history strip** +
  the current proposal held client-side is all the “conversation” the UI needs; `refine`
  posts `prior` back (matches `00 §8.2` — no `ai_sessions` table).

## §5 Summary must name the cost, not just the win (finding)

When an instruction forces a trade (e.g. “final last” strands a mid-day gap), the value is in
the model **owning the compromise** in `summary` (“…that leaves a mid-day gap, the cost of
your ‘final last’ wish”). The UI must render `summary` **prominently at the top of the result**
and never truncate it below three sentences. This is the difference between “the AI ignored
me” and “the AI understood the tension and told me.”

**Usage transparency** (`in / out / repair rounds / 0 blocking` as small mono chips) read as
*trust*, not noise, for the Pro audience (“quality over cost”, `00 theme`). Keep a subtle
usage row in the summary card.

## §6 Accept / apply (unchanged from 43 §4, restated for the contract)

`Accept & apply` → create `before-ai` checkpoint → `applySchedule` (`source:"ai"`,
`expected_seq` via existing seqRef) → if `constraint_suggestions` present, a **checked-by-
default** “Also save these rules” list applies via schedule-settings PUT (opt-in, `00 §8.6`) →
refetch + toast with undo. Applied blocks flip to **teal** (verified). `SEQ_CONFLICT` →
refetch + “Re-run as refine”. Blocking assignments keep `Accept` disabled until the organiser
unticks blockers (they drop to the unscheduled tray). `Discard` → `ai_plan_discarded`.

## §7 States to build (from the prototype)

`idle` (console hidden) · `running` (stepper animating, board tag = “proposing…”) ·
`flagged` (transient red, board tag = “referee flagged a conflict”) · `proposal`
(diff-coloured, result panels shown, board tag = “proposal · engine-verified”) · `applied`
(all teal, checkpoint banner: `before-ai` + `schedule_applied · source:ai`). Plus the error
states from `00 §7` rendered **inline in the panel** (503/402/422/429), never toast-only.

## §8 Open questions for implementation

1. **Motion budget** — prototype used ~2–4s of orchestrated animation. Confirm acceptable vs.
   an instant “show trace, then board” for power users; consider a per-user “skip animation”
   pref beyond `prefers-reduced-motion`.
2. **Grid ghosts at 390px** — 43 §6 drops grid ghosts for an agenda list on mobile. The
   prototype is desktop-first; the mobile agenda diff still needs the §1 colour contract and
   the §0 referee trace (as a collapsible log).
3. **Streaming** — `00 §8.4` defers streaming. If the referee trace is the headline, a
   streamed console (tokens/steps arriving live) would strengthen it; log as the natural
   follow-up if p95 latency makes the static trace feel slow.
