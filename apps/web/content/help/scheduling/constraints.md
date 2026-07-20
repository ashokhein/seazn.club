---
title: Scheduling constraints
description: Play hours, rest gaps, court preferences — the rules Auto-schedule must respect.
order: 4
---

Constraints are the rules the auto-scheduler plays by. They live in the division's **schedule settings**. Courts, match length and the start/end dates are also asked once on the **Scheduling** step when you create the division — the settings panel is where you change them afterwards.

## The basics (all plans)

- **Play hours** — when the venue is yours, per day.
- **Courts** — what your court is called. More than one court in parallel is Pro.
- **Match length** — how long a fixture blocks a court, derived from the sport but overridable.

## Finer control (Pro)

- **Multiple courts** — run matches in parallel across a venue.
- **Rest gaps** — minimum minutes between an entrant's matches.
- **Unavailability** — "Rockets can't play before 10am Saturday".
- **Court preferences** — finals on Court 1, wheelchairs on the accessible court.
- **Describe it in words** — type "45 players, 2 courts, done by 6pm, nobody plays twice in a row" and the assistant proposes constraints; you review and apply, nothing is set silently.

To go further and have the same plain-language instruction lay out the whole timetable, see [AI Schedule](/help/scheduling/ai-scheduling).

## Field fairness

Over a long day some entrants end up on the same court every round while others move about. **Field fairness** evens that out — but only as a tie-break.

When the scheduler has two courts free at the same moment, it picks between them:

- **Balance courts** — give the entrant the court they have used least so far.
- **Rotate every game** — avoid the court they played on last.
- **Off** — take whichever court comes first.

Kick-off times always win. If the fairer court is only free later, the match goes on the earlier one anyway; no fixture is ever delayed to even out courts. So on a tight timetable with few spare courts, turning this on may change nothing at all.

## Diagnosing a day

The **schedule report** shows each entrant's shortest and longest waits — the fastest way to spot the poor team sitting idle for three hours before you print anything.
