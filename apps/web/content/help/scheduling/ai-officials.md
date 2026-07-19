---
title: AI Officials
description: Staff your matches automatically — AI Officials assigns officials around their roles, blackout dates and other bookings, and the engine referees every proposal before you apply it.
order: 9
---

**AI Officials** is the second phase of AI scheduling: once the times are set, it staffs the matches. Assign referees and other officials across the whole timetable from one instruction — or leave the instruction empty for a sensible default spread. Like the schedule pass it is **propose-only**: nothing is written until you apply. Automatic officials assignment is a **Pro Plus** feature.

## Where it fits

You reach the officials pass from the AI console straight after the [schedule pass](/help/scheduling/ai-scheduling), working over the times you just proposed (even before they're applied). It respects everything the [Officials tab](/help/scheduling/officials) does — roles, blackout dates, per-day limits and "booked elsewhere" warnings — and never moves an assignment you've locked.

## What it does

- **Fills every required role** on each fixture from your officials pool, honouring who holds which role.
- **Avoids conflicts** — an official can't referee two matches at once, exceed their per-day limit, work on a blackout date, or clash with a booking in another organisation.
- **Leaves locked assignments alone**, echoing them back unchanged.
- **Flags coverage gaps** — a slot with no eligible official is shown as unfilled rather than forced, and where a spare official *could* cover it, the architect suggests them.

Give it an instruction ("keep the same referee across a team's group games") to steer it, or run it with no instruction to get the deterministic solver's default spread. The engine referee checks every proposal and repairs blocking clashes for up to two rounds before showing you what's left.

## Run quotas

Unlike schedule generations, **officials AI runs are not metered** — restaff as often as you like. The empty-instruction default spread is produced without a model call at all, so it's effectively free.

## Applying

Applying writes the assignments to the fixtures and notifies the officials, exactly as a manual assignment would, with the AI provenance recorded. Manual, one-official-per-fixture assignment still works on every plan — see [Officials and referees](/help/scheduling/officials).

Related: [AI Schedule](/help/scheduling/ai-scheduling), [Officials and referees](/help/scheduling/officials), [the schedule board](/help/scheduling/board).
