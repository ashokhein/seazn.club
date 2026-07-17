# Officials — end-to-end walkthrough

**Interactive artifact (real screenshots + annotations):**
https://claude.ai/code/artifact/690c4b06-8bfc-482b-8d9d-4833b0bbb137

A six-stage visual walk of the officials / scoring flow, captured from a seeded
demo (Riverside Summer Cup → Open Singles).

| # | Persona | Stage | What happens |
|---|---------|-------|--------------|
| 01 | Organiser | Onboard the official | Add referees / umpires / judges to the org-wide roster, or invite them to claim a profile. |
| 02 | Organiser | Assign roles & fixtures | Put an official on a fixture with a role, or auto-propose a fair spread across the schedule. |
| 03 | Official | Claim the profile | The invite opens a claim page; signing in links the officiating profile to their own account. |
| 04 | Official | Accept the fixture | Assignments land in `/me` — accept or decline each, and set blackout dates. |
| 05 | Official | Score on the full board | Accepted → the match shows in My Matches → the full console (Start · Forfeit · Abandon · score · finalize). |
| 06 | Organiser | Conflicts, surfaced | A decline or scheduling clash shows on the schedule board as a conflict badge + a re-assign cue. |

Notes:
- An **accepted assignment is the authority** — officials score the full board without ever joining the org (design "Option 2", read-union).
- The board needs **both entrants set** — a "vs TBD" slot stays read-only until its feeder resolves.

Design + build detail: `docs/superpowers/specs/2026-07-17-officials-unify-umpire-design.md`
and `docs/superpowers/plans/2026-07-17-officials-unify-umpire.md`.
