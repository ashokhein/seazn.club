---
title: AI Schedule
description: Describe your timetable in plain language and let AI Schedule plan, refine and repair it — the engine checks every proposal, and nothing is written until you apply.
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

## Credits and rate limits

AI Schedule needs no upgrade — it runs on **every plan, Community included**. There is no per-division run cap any more: every run is metered by your organisation's shared **AI credit wallet** instead. Generate, refine and repair each spend **one AI credit**, and the officials pass spends one too — including its no-instruction default spread, which makes no model call but still draws from the wallet. A run that fails or times out is **refunded**, so it never costs you a credit. See [AI credits](/help/billing/credits) for the monthly grant, buying packs, and how a billing group shares one wallet.

Separately, every plan has a burst brake of **5 AI runs an hour per division** for scheduling, and its own **5 an hour** for officials — independent counters, so a busy hour staffing matches doesn't use up your scheduling budget or the other way round.

## Applying and undo

Applying writes the times (and, if you included them, the officials) to the board and marks those fixtures as AI-scheduled. It first creates a **before-AI** save point, so **undo** puts everything back exactly as it was. The instruction you typed is kept with the applied schedule, so you can always see what you asked for.

Related: [the schedule board](/help/scheduling/board), [scheduling constraints](/help/scheduling/constraints), [undo and save points](/help/scheduling/undo), [AI Officials](/help/scheduling/ai-officials).
