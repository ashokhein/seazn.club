---
title: AI Schedule
description: Describe your timetable in plain language and let AI Schedule plan, refine and repair it — one division or several at once. The engine checks every proposal, and nothing is written until you apply.
order: 5
---

**AI Schedule** turns a plain-language instruction — "finish by 6pm, nobody plays twice in a row, finals on Court 1" — into a full timetable. Open it from the schedule board's **AI schedule** button. It is **propose-only**: the model suggests times and courts, the deterministic engine verifier checks the proposal, and **nothing changes until you apply it**.

## The two phases

Scheduling runs in two passes, and you can stop after the first:

1. **Schedule** — the architect places every movable fixture on a court and time. This phase runs on **every plan** (within the credits and rate limit below).
2. **Officials** — once you're happy with the times, the architect can staff the matches, assigning referees and other officials around their roles, blackout dates and other bookings. Like the schedule pass, it runs on **every plan** too — see [AI Officials](/help/scheduling/ai-officials).

You can apply the schedule on its own, or apply both together.

## What the AI sees

The architect only ever sees this division's own scheduling picture, assembled into one deterministic brief:

- the fixtures it may move, plus any pinned ones it must leave alone;
- entrants, and players shared across entrants (so it never double-books a person);
- your courts, play hours, blackout windows and existing constraints;
- other divisions' bookings on shared courts — as blocked time only, never their names or rosters;
- for the officials pass: your officials, their roles, per-day limits, blackout dates and "booked elsewhere" times.

It cannot see another organisation's schedule, roster or results — only that a slot is taken.

Your data stays yours: the brief is sent to one of our AI providers — Anthropic (Claude), Google (Gemini) or xAI (Grok), some reached through the OpenRouter gateway — only to produce the proposal, and it is **not used to train AI models**. Requests routed through OpenRouter additionally carry zero-data-retention terms. Nothing beyond this division's scheduling brief ever leaves seazn.club — never your whole account, member emails or billing details. See our [sub-processors list](/legal/sub-processors) for the full set of AI providers.

## Generate, refine, repair

- **Generate** builds a fresh timetable from your instruction.
- **Refine** adjusts the current proposal — "pull the semifinals earlier" — without starting over.
- **Repair** is the scoped fix. When something later breaks the board (a new blackout, a venue clash), the board shows a **"needs repair"** nudge; **Fix with AI** opens the console focused on just the affected slots, so the rest of the timetable stays put.

Every proposal is checked by the same engine that powers the drag-and-drop board. Blocking clashes (a double-booked court, a final before its feeder finishes) are repaired automatically for up to two rounds; anything left over is shown to you rather than hidden. Rest gaps, session windows and soft warnings are surfaced, never silently ignored.

## What a run costs

AI Schedule needs no upgrade — it runs on **every plan, Community included**. There is no per-division run cap any more: every run is metered by your organisation's shared **AI credit wallet** instead. Generate, refine and repair are all metered the same way, and so is the officials pass.

Before anything is spent, the console shows a **Run cost** card: how big the job is (fixtures, courts, an estimated token count) and how many credits it will charge. Nothing is taken until you press the button.

### Credits buy a thinking budget, not usage

A credit does not buy "a run". It buys the model a **budget of thinking tokens** for that run:

| Credits | Thinking budget for the whole run |
| --- | --- |
| 1 | up to 32K tokens |
| 2 | up to 64K tokens |
| 3 | up to 128K tokens |

The price is fixed the moment you confirm. A run that needs less than its budget is not partly refunded, and a run that reaches the ceiling stops there rather than quietly costing more. A run that fails outright — no usable timetable at all — is **not charged**: the hold on your wallet is released.

### Choosing how many credits to spend

The card pre-selects the number the size of the job suggests — a short league lands on 1, a multi-day tournament across many courts on 3 — and you can move it up or down before confirming.

Moving it **down** is allowed and costs less, but the run then has the smaller budget to work in. That is what the warning "**may stop before a full schedule**" means: the model can reach the ceiling part-way through and hand back a partial or rougher timetable instead of a complete one. You still see whatever it produced, checked by the engine exactly as usual, and you can apply it, discard it, or run again at the higher setting.

Moving it **up** buys more room for an unusually awkward brief. If the card calls the run **very large** even at 3 credits, more budget is not the answer — split the division and schedule it in parts.

The officials pass has its own sizing (its briefs are lighter, so it almost always lands on 1), and its no-instruction default spread makes no model call at all and is charged a flat 1 credit. See [AI Officials](/help/scheduling/ai-officials).

See [AI credits](/help/billing/credits) for the monthly grant, buying packs, and how a billing group shares one wallet.

Separately, every plan has a burst brake of **5 AI runs an hour per division** for scheduling, and its own **5 an hour** for officials — independent counters, so a busy hour staffing matches doesn't use up your scheduling budget or the other way round.

## Scheduling several divisions together

The competition's own schedule board (**Competition → Schedule**) can plan **several divisions at once**, so divisions sharing a venue are fitted around each other in a single pass instead of being scheduled one at a time and patched up afterwards. The multi-division board is a **Pro** feature.

Pick the divisions in the console, write one instruction covering all of them, and review the proposal division by division. Applying writes every division together — all of them or none — and each division gets its own **before-AI** save point, so one undo puts the whole thing back.

**Shared courts are matched by name, and by nothing else.** There is no venue-wide court list behind the scenes: a court is the label you typed into each division's schedule settings. So "Court 1" in one division and "Court A" in another are **two different courts** as far as the run is concerned, and it will happily put a match on each at the same time. If the divisions you picked don't use the same names, the console warns you before the run — the fix is to make the names match in each division's schedule settings.

Two more limits worth knowing:

- A joint run needs **at least two divisions**. To schedule one on its own, open its own schedule page.
- The whole run is capped at **500 fixtures to place**, the same ceiling a single division has. Over that, run the divisions in smaller groups.

A division with nothing left to place is skipped rather than charged for, and a frozen division can't be picked at all.

### What a joint run costs

Each selected division is sized on its own, exactly as it would be alone, and then the run gets a **batch discount of one credit**:

> **credits charged = (the divisions' credits added up) − 1**, never less than 1.

Three divisions sized 1, 2 and 3 add up to 6 and are charged **5 credits**. The receipt lists each line, the discount and the total before anything is spent, and every line has its own credits picker with the same meaning as above.

One thing that surprises people: the **thinking budget is sized from the undiscounted total**, not from what you pay. Those three divisions get the budget 6 credits buys while being charged 5 — the batch discount lowers the price, never the capability, so scheduling divisions together is never a worse deal than scheduling them one at a time.

## Applying and undo

Applying writes the times (and, if you included them, the officials) to the board and marks those fixtures as AI-scheduled. It first creates a **before-AI** save point, so **undo** puts everything back exactly as it was. The instruction you typed is kept with the applied schedule, so you can always see what you asked for.

Related: [the schedule board](/help/scheduling/board), [scheduling constraints](/help/scheduling/constraints), [undo and save points](/help/scheduling/undo), [AI Officials](/help/scheduling/ai-officials).
