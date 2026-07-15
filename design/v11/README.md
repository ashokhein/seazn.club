# v11 — Referee / Umpire Onboarding

> **Status (2026-07-14):** design only. PROMPT-57 not yet implemented.
> Target branch (build time): `feat/v11-official-onboarding` (own worktree off
> `main`). **Depends on nothing in v10** — can build in parallel — but its
> printable rota is consumed by v12, so land v11 before v12.
> **Migrations:** one new delta, **use the next free `V###`** after v10's
> (check V-number contention).

## Theme

The **officials engine is already built** — it just has no human on the other
end. `apps/web/src/server/usecases/officials.ts` + `@seazn/engine/officials`
give an `officials` table (`org_id, person_id, entrant_id, display_name,
role_keys[], home_pool_id, max_per_day`), CRUD, spreadsheet import, seeded
auto-assign, and per-fixture manual set/lock; `fixture_officials` is the write
source and `fixtures.officials` the denormalised read cache. An organiser can
already conjure a referee named "Priya" and drop her onto Court 3 at 09:15.

What's missing is **Priya**. There is no way to invite a real person to an
official record, no way for that person to claim it, and nowhere for them to see
their own assignments, say "can't do Sunday", or reach the score pad for a match
they're reffing. Players already have this whole path (PROMPT-53: invite →
claim → `/me`); officials have none of it.

**v11 gives officials the player-account treatment, reusing that infra
end-to-end:**

- **Invite** an official by email from the officials manager
  (`usecases/invites.ts`, `email-templates/claim-invite.ts` are the pattern).
- **Claim** links the invite to the signed-in user and stamps
  `officials.person_id` (`usecases/person-claims.ts`, `claim/[token]/page.tsx`).
- **Portal** lives inside **`/me`** (decision taken in brainstorming — one
  identity, a person can be both a player and a referee): an *Officiating* lane
  showing assigned fixtures (`me/assigned-fixtures` already returns them),
  **accept / decline** per assignment, **availability / blackout dates**, the
  **device link** to score each assigned match, and a **printable rota** (the
  v12 doc).

## Prompts

- `prompts/PROMPT-57-official-onboarding.md` — `officials.email` + claim
  linkage; `official_availability` (blackout dates) + `fixture_officials.response`
  (pending/accepted/declined); invite/claim flow reusing the person-claim rail;
  `/me` officiating lane (assignments, accept-decline, availability, device
  link); assignment + change notification emails; `/me/rota.pdf` hook for v12;
  help, smoke, tests.

## Non-goals (explicit)

- **Pay / match fees / expense tracking** — deferred (overlaps v10's Connect
  money work; officiating payouts are a wave of their own).
- **Qualifications / certifications on file** — the badge/grade of a referee is
  out; `role_keys` stays the only capability signal for v11.
- **Auto-reassign on decline** — a declined assignment flags on the organiser's
  console for a manual re-pick; the engine is not re-run automatically.
- **A separate `/officials` app or portal** — explicitly folded into `/me`.
