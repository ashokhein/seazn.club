---
title: Score conflicts
description: Two scorers hit the same match at once — the app refreshes to the latest instead of overwriting.
order: 2
---

Occasionally two people score the same match at the same moment — a courtside scorer and an admin fixing something from the desk.

## What you'll see

The slower entry gets a brief "someone else scored first" notice and the pad refreshes to the latest score. Nothing is lost or overwritten — the app simply refuses to write over a score it hasn't seen.

## What to do

Look at the refreshed score. If your point is already there, you're done — the other person entered the same thing. If it's missing, enter it again on top of the fresh score.

## Why it works this way

Every match's results are a numbered ledger; each entry states which number it expects to follow. Two entries claiming the same number can't both land, so the ledger can never fork — that guarantee is what lets phones, tablets and integrations all score the same event safely.

**Seeing it constantly?** Two devices are probably assigned to the same court. Give each court its own [device link](/help/scoring/device-links).
