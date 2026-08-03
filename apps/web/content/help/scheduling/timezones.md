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

- Click the picker and **type a city or country** — "dubai", "india", "UAE" all find the same zone.
- Or press **Detect** to use your device's.
- The **Current time here** preview confirms your choice at a glance.
- Leave it on **Use my browser's timezone** and we follow whatever device you're on.

Your choice is saved to your account, so it follows you across devices. It only ever changes *your* times and the local-time hints — it never moves a venue's schedule.

## Set the venue timezone

**Settings → Organisation → Scheduling timezone** (owners and admins).

- Applies to every competition and division in the organisation.
- Leave it unset and schedules are shown in **UTC**.
- Changing it re-labels existing fixtures: the stored instant does not move, but the wall-clock time you see does. Set it before you publish a timetable.

## One clock for scheduling

Everything the scheduler works out in time runs on **one clock: the organisation's scheduling timezone**. Day boundaries, what counts as "Saturday", your play hours and the times written onto the board are all resolved in that single zone, for every division in the organisation.

This matters if a division still carries a timezone of its own. Some do — saved before the setting moved up to the organisation — and such a zone is now only a **label**. It still decides how that division's times are spelled out on screen, but it no longer decides what the scheduler treats as a day, a weekday or an evening.

The honest consequence: a division whose own zone differs from its organisation's has its matches land **shifted by the difference between the two offsets**. Ask for "Saturday evenings" in a division labelled three hours ahead of the organisation and the plan is built around the *organisation's* Saturday evening, not that division's.

One clock is deliberate — a competition running to two sets of day boundaries produces timetables nobody can reconcile — but the shift is real, so it is worth knowing before you plan across zones.

**The way round it is to state the hours instead of describing them.** Play hours you set by hand are fixed points on the calendar rather than "6pm in whichever zone", so none of the above moves them. If a division genuinely runs in a different zone from the rest of the organisation, set its play hours explicitly and the plan will honour exactly the hours you picked.

## Finding a zone in the picker

Both pickers work the same way. Click, then **type** — the list narrows as you go, and matches on the city, the country, or the country code. Every row shows the country and the **current local time**, so you can confirm you have the right one before you commit.

With the box empty, zones are grouped under the region you'd actually look under: Dubai sits under **Middle East**, Mumbai under **South Asia**, Singapore under **South-East Asia**. (The underlying timezone database files all three under "Asia", which is why they used to be jumbled together.)

Zones you're likely to want — the one already saved, and the one your browser reports — sit at the top under **Suggested**.

## Why does a time show an offset like GMT+5:30?

Most zones have a friendly short name (IST, BST, EDT). A few don't, so we show the UTC offset instead — it means the same thing, just spelled numerically.
