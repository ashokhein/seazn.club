---
title: Officials and referees
description: Invite officials to claim their profiles, read accept/decline responses and blackout dates, and let them score straight from the fixture console.
order: 6
---

Officials are your umpire/scoring path: invite one, they claim their profile, accept the assignment on their `/me` home, and score the match on the same full fixture console you use — no separate scorer role, no device link to mint. Officials are an org-wide pool, managed from **Directory → Officials** — the same roster is shared across every competition and division, so you add and invite an official once and pick them on any schedule. A division's **schedule → Officials tab** stays where you assign them to fixtures: auto-assign, manual pick, phased sourcing from results, and blackout warnings. Inviting an official, their home view, accepting and declining, blackout dates, and scoring are **available on all plans**.

**One official per fixture is free on every plan.** Assigning a *second* official to the same fixture — a referee and a line judge, say — needs **Pro Plus**; Community and Pro stay at one. **Multiple roles on one official** (see below) is a separate, Pro-and-up rule about how many hats one person wears, not how many people cover a match.

## Add and invite an official

In **Directory → Officials**, **Add official** creates a roster entry; pick their role(s) as chips (referee, umpire, judge, scorer and more — or add a custom one). **Multiple roles on one official are a Pro feature**; on the free plan, picking a second chip swaps the selection instead of stacking it. Next to any official, choose **Invite** and enter their email. They get a claim link — the same claim system players use, so the rules match: **only an account signed in with the invited address can accept**, invites last 14 days, and re-inviting quietly withdraws the previous link. Once accepted the official shows a **Linked** chip; an outstanding invite shows **Invited**. **Invite all with email** re-invites everyone who has an address but no link yet.

## Edit roles or remove an official

On any roster row, **Edit roles** opens the same chip picker to change an existing official's roles (the free-plan single-role rule applies here too), and **Delete** removes them after an explicit confirmation. Deleting removes the official from *this organisation only* — their roster entry, their fixture assignments and their availability dates here. It never touches their account: a linked official keeps their login, their `/me` home, any player profiles, and their officiating profiles with other organisations. If they should come back later, just add and invite them again.

## Assigning on a division's schedule

The schedule's **Officials tab** shows a compact roster strip (with a link back to the directory to manage it) plus the assignment tools: propose/apply an auto-assignment, phase officials in from results, or pick manually per fixture. Every official in the org-wide pool is available to every division — there's no separate roster per division. **Automatic officials assignment (propose/apply) is a Pro Plus feature** — picking officials manually, one per fixture, works on Community and Pro too. To staff a whole timetable from one instruction, see [AI Officials](/help/scheduling/ai-officials).

## What the official sees

A linked official gets an **Officiating** section on their personal home (`/me`, same login as any player profile they hold):

- **My assignments** — each fixture with competition, court and time (shown in the venue's timezone and their own).
- **Accept / Decline** — declining asks for an optional reason. Once accepted, an assignment can't be self-declined; they'll need to ask you. A decline can be re-accepted up until matchday.
- **Can't make these dates** — blackout dates that apply across every organisation they officiate for.
- **Score this match** — once accepted, this opens the same full fixture console you score from — same login, no separate device link to mint. It also shows up on their **My matches** page, alongside anything a scorer seat has assigned them. A pending or declined assignment has no scoring door: only an accepted one opens the console.

## Officiating for more than one organisation

Officials often work for several organisations, and each invite is its own one-claim-per-org link. If an invite is waiting on your login's email — whether or not you've linked an officiating profile yet — `/me` shows a **Pending invites** card: "*\<Org\> set up an officiating profile for \<Name\>*", with an **Accept** button right there. No token, no link to hunt down in your inbox: your signed-in email is what proves it's for you, exactly like clicking the emailed link would. Accepting one invite never touches the others — link as many organisations as you officiate for, whenever their invites arrive.

## Responses on your console

Each assignment chip on the Officials tab carries the response: **✓ accepted**, **· pending**, **✗ declined** (hover for the reason). A decline is a flag for you to re-pick manually — **nothing is reassigned automatically**, and your locked assignments never move.

Existing assignments from before this feature count as **accepted** — nothing lights up red on upgrade day.

## Blackout dates when assigning

If an official marked a date unavailable, the assign picker suffixes their name with **unavailable** and assigned chips show a **⚠** on that date. It's a warning, not a block — you can still assign them if you've agreed it.

## Booked-elsewhere warnings

An official who officiates for more than one organisation can end up double-booked without either organiser knowing — blackout dates only cover time the official marked off themselves, not time another organisation already assigned them. If a claimed official has a match around the same time in a *different* organisation, the assign picker suffixes their name with **booked elsewhere · \<time\>** and an assigned chip shows the same badge on that fixture. Like the blackout warning, this is informational only — nothing is blocked or auto-reassigned. **Privacy note:** the warning shows only a time. It never reveals which organisation, competition or match the official is booked with — your console can't see another organisation's roster, schedule or name, only that a clash exists.

## Conflict signals on the schedule board and fixture page

Two more places surface an official's response, both organiser-only:

- **Schedule board conflict badges** — a fixture with a declined assignment shows **umpire declined**; one where the assigned official has a blackout date on that day shows **umpire unavailable**. Both sit alongside the board's other warnings (double-bookings, venue clashes) as non-blocking flags — nothing is auto-reassigned, exactly like the Officials tab's own response chips.
- **Assigned-officials strip on the fixture page** — opening a fixture you can edit shows a small chip per assigned official (accepted/pending/declined), with the decline reason on hover. It's the fastest way to check who's covering a specific match without leaving the score console.

## Emails officials receive

- **You've been assigned** — sent when you assign them to new fixtures (manually or by applying an auto-proposal), with an accept/decline link.
- **Assignment changed** — sent when a fixture they're assigned to moves time, court or venue.

Both go to the official's email; nothing is sent for re-applying an unchanged assignment.
