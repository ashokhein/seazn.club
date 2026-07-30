---
title: AI Officials
description: Staff your matches automatically — AI Officials assigns officials around their roles, blackout dates and other bookings, and the engine referees every proposal before you apply it.
order: 9
---

**AI Officials** is the second phase of AI scheduling: once the times are set, it staffs the matches. Assign referees and other officials across the whole timetable from one instruction — or leave the instruction empty for a sensible default spread. Like the schedule pass it is **propose-only**: nothing is written until you apply. Like the schedule pass, it needs no upgrade — it runs on **every plan, Community included**.

## Where it fits

You reach the officials pass from the AI console straight after the [schedule pass](/help/scheduling/ai-scheduling), working over the times you just proposed (even before they're applied). It respects everything the [Officials tab](/help/scheduling/officials) does — roles, blackout dates, per-day limits and "booked elsewhere" warnings — and never moves an assignment you've locked.

## What it does

- **Fills every required role** on each fixture from your officials pool, honouring who holds which role.
- **Avoids conflicts** — an official can't referee two matches at once, exceed their per-day limit, work on a blackout date, or clash with a booking in another organisation.
- **Leaves locked assignments alone**, echoing them back unchanged.
- **Flags coverage gaps** — a slot with no eligible official is shown as unfilled rather than forced, and where a spare official *could* cover it, the architect suggests them.

Give it an instruction ("keep the same referee across a team's group games") to steer it, or run it with no instruction to get the deterministic solver's default spread. The engine referee checks every proposal and repairs blocking clashes for up to two rounds before showing you what's left.

## Credits and rate limits

AI Officials is metered the same way as the schedule pass: every run spends credits from your organisation's shared wallet, and those credits buy the model a **thinking budget** for that run rather than a flat ticket. Officials briefs are much lighter than scheduling ones, so the card almost always sizes an officials run at **1 credit** — and the no-instruction default spread, which makes no model call at all, is charged a flat 1 credit as well. **On an instructed run** you can move that number up or down before confirming, exactly as on the schedule pass, and a pick below the recommendation gets the smaller budget and the "may stop before a full schedule" warning. The default spread shows no picker: its price is fixed at 1 credit and there is no thinking budget to buy, so there is nothing to move. A run that fails or times out is **not charged**. See [AI Schedule](/help/scheduling/ai-scheduling) for how the sizing works, and [AI credits](/help/billing/credits) for the monthly grant, buying packs, and how a billing group shares one wallet.

Separately, officials AI has its own burst brake of **5 runs an hour per division** — independent of the schedule pass's own hourly limit, so a busy hour staffing matches doesn't use up your scheduling budget or the other way round.

Instruction runs carry the same data guarantee as the [schedule pass](/help/scheduling/ai-scheduling): only this division's officials brief is sent to one of our AI providers, and it is **not used to train AI models**. See our [sub-processors list](/legal/sub-processors) for the full set.

## Applying

Applying writes the assignments to the fixtures and notifies the officials, exactly as a manual assignment would, with the AI provenance recorded. Manual, one-official-per-fixture assignment still works on every plan — see [Officials and referees](/help/scheduling/officials).

Related: [AI Schedule](/help/scheduling/ai-scheduling), [Officials and referees](/help/scheduling/officials), [the schedule board](/help/scheduling/board).
