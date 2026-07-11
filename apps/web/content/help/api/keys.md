---
title: API keys
description: Read, score or manage — scoped keys for integrations, with an optional one-competition limit.
order: 1
---

API keys (Pro) let your own software talk to seazn.club — pull standings into your website, push live scores from a scoreboard system, automate entries.

## Scopes

Every key has one scope; pick the smallest that does the job:

- **Read** — fetch competitions, fixtures, standings, registrations. Can't change anything.
- **Score** — read, plus push live scores and start divisions. For scoreboard integrations.
- **Manage** — the full surface. Treat it like a password.

You can also **limit a key to one competition** — hand it to a vendor and it physically can't touch anything else.

## Handling keys

The secret is shown **once**, at creation — store it somewhere safe. Revoke any key you no longer use; revocation is instant. Each key shows its last-used time, so stale ones are easy to spot.

## For your developers

Send them to the [developer docs](/developers) — full API reference, guides and a try-it console.
