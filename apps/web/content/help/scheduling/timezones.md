---
title: Timezones — venue time vs your time
description: Why a match shows the venue's local time everywhere, how to set your own timezone, and where your time is used instead.
order: 6
---

Seazn shows every time with its **timezone spelled out** — `19:00 IST`, `14:30 BST` — so a time is never ambiguous. There are two lanes, and knowing which is which explains everything.

## Venue time (schedules)

A match happens at the **venue's** wall clock. A final in Chennai is **19:00 IST** whether you open the schedule from London, New York, or courtside. So every schedule — the fixture board, the public league page, round headers — shows the **venue's** timezone, the same for every viewer.

You set it **once for the whole organisation**, under **Settings → Organisation → Scheduling timezone**, and every division inherits it. There is no per-division timezone to remember — set it to where you play, not to where you are. A London-based organiser running an event in Malaga sets `Europe/Madrid` here; their own account timezone stays London.

We never quietly convert a schedule to your device's zone: that's how people miss matches.

## Your time (everything about you)

Your own times — **/me** (your schedule), account activity, billing renewal dates — show in **your** timezone. And beside every venue time we add your local equivalent, in teal, so you know when to tune in without doing the maths:

> **19:00 IST**
> ↳ 14:30 BST

The second line only appears when your timezone differs from the venue's.

## Set your timezone

**Settings → Account → Preferences → Timezone.**

- Pick any zone from the list, or press **Detect** to use your device's.
- The **Current time here** preview confirms your choice at a glance.
- Leave it on **Use my browser's timezone** and we follow whatever device you're on.

Your choice is saved to your account, so it follows you across devices. It only ever changes *your* times and the local-time hints — it never moves a venue's schedule.

## Set the venue timezone

**Settings → Organisation → Scheduling timezone** (owners and admins).

- Applies to every competition and division in the organisation.
- Leave it unset and schedules are shown in **UTC**.
- Changing it re-labels existing fixtures: the stored instant does not move, but the wall-clock time you see does. Set it before you publish a timetable.

## Why does a time show an offset like GMT+5:30?

Most zones have a friendly short name (IST, BST, EDT). A few don't, so we show the UTC offset instead — it means the same thing, just spelled numerically.
