# Competition lifecycle and pass integrity — design

**Date:** 2026-08-05
**Branch:** `fix/pass-lock-376` (worktree `/Users/ashokhein/github/wt-pass-376`, forked from `origin/main` at `ea0ffaf2`)
**Issue:** #376 (part A). Parts B and C were raised by the owner during
brainstorming; per the owner's standing rule for this branch **no new
issues are filed** — they are specified here and fixed inline.

## The seam

Three defects sit on one seam: what a competition becomes when it stops
being live, and what the product may still sell or count once it has.

A competition leaves the live state in two ways — a terminal status
(`completed`/`archived`) or running past `ends_on` plus grace. Crossing
that line is supposed to mean two things: no Event Pass may be sold for
it, and its resources stop being live inventory. Today the first is
enforced only at the API, the line itself is unreachable for most
competitions, and one resource refunds its quota on the way out.

- **A** — the buy offer survives the line, and the API refuses the sale.
- **B** — `ends_on` is optional, so the date arm of the line rarely fires.
- **C** — archiving a division refunds its quota slot, so archive→recreate
  is an unlimited-divisions loop.

## Part A — the pass line versus the offer surfaces

### What is broken

A competition that is `completed`/`archived`, or past `ends_on` + grace,
**and has never held a pass**, still shows `🎫 Event Pass — from $29
one-time` in its header. `POST /api/billing/pass-checkout` refuses that
purchase with **410 Gone**
(`apps/web/src/app/api/billing/pass-checkout/route.ts:180`).

Two claims in issue #376 are wrong and the implementation must not
inherit them:

1. The issue says the checkout **400s**. It is **410**, with its own arm
   in `passCheckoutErrorKey`.
2. The issue says `upgradePageState` returns `{kind:"ended"}` on any lock
   reason regardless of whether a pass was held, and concludes "the
   damage is a misleading chip, not a broken flow". **False.** The
   `ended` arm sits inside `if (input.hasPass)`
   (`apps/web/src/lib/upgrade-page-state.ts:98-100`), a guard added by
   `86168e45` (#327) *after* #301 wrote that card. A never-held locked
   competition therefore falls through to `{kind:"offer"}` and renders a
   live checkout. The organiser gets a Buy button that dead-ends in a
   410.

### Root cause

The lock is judged as a property of the **purchase** when it is a
property of the **competition**. Both surfaces write the same line:

- `apps/web/src/app/o/[orgSlug]/c/[compSlug]/layout.tsx:183`
- `apps/web/src/app/o/[orgSlug]/c/[compSlug]/upgrade/page.tsx:220`

```ts
lockReason: pass ? passLockReason(pass.status, pass.ends_on) : null
```

With no pass row the lock is never computed at all, so the gate ordering
noted in the issue (`competition-pass-provider.tsx:228-233`, `passKey`
checked before `lockReason`) is a second layer over a value that is
already `null`. Fixing only the gate ordering would change nothing.

The layout's query compounds it: it `INNER JOIN`s `competitions` through
`competition_passes`, so `status` and `ends_on` are not even fetched when
no pass exists. `compBySlug` returns `id, name, slug` only.

### The design

**1. Judge the competition, not the purchase.** Both sites compute
`lockReason` unconditionally. The layout query becomes a `LEFT JOIN` from
`competitions` to `competition_passes` — same single round trip, no extra
query:

```sql
select cp.pass_key, c.status, c.ends_on
from competitions c
left join competition_passes cp on cp.competition_id = c.id
where c.id = $1
limit 1
```

`lockReason` keeps its existing meaning for a held pass and gains a
second: with no pass row it means "this competition is closed to passes".

**2. A fourth gate state.** `PassGateState` gains `"closed"` — *sellable:
no, held: never*. Precedence in `usePassGateState`:

```
paid_plan  →  closed  →  none  →  ended  →  held
```

`closed` is `passKey === null && lockReason !== null`. It sits after
`paid_plan` because a paid plan already suppresses the chip and
`paid_plan` is not a lie for a closed competition; it sits before `none`
because `none` is what puts the buy link on a refused purchase.

The existing comment at `competition-pass-provider.tsx:219-221` — "a lock
reason with no pass row stays `none` rather than inventing an ended card
for a pass that was never bought" — was **right about the `ended` card**
and is superseded only in its conclusion. The reasoning is preserved:
`closed` is a distinct state precisely so no ended card is invented.

**3. The chip.** `CompetitionPassEntry` renders `closed` **editor-gated**
(`canBuy`), unlike the `ended` card. The ended card shows to everyone
because it is a fact about the competition; `closed`'s only content is an
action link, and a lone link shown to someone who cannot act is noise.

The two lock reasons get **different next steps**, the same split #301
paid for:

| reason | copy | destination |
| --- | --- | --- |
| `terminal` | `pass.entry.ended.nextEdition` — "Create next year's edition" (exists in all 4 locales) | `routes.competitionNew(org)` |
| `past_ends_on` | **new key** `pass.entry.closed.updateEndDate` — "Update the end date" | `routes.competitionSettings(org, comp)` |

`past_ends_on` is **recoverable**: fixing the date puts the competition
back before the line and the pass becomes buyable again. Pointing that
organiser at next season would be the wrong next step for a competition
whose only problem is a stale date.

Selection is via a `Record<PassLockReason, …>` lookup, never a ternary —
the same rule the upgrade page states at its `PASS_LOCK_REASON_KEY` site,
so a third lock reason is a compile error rather than a wrong sentence.

**4. The upgrade page.** `upgradePageState` gains a fifth kind:

```ts
| { kind: "closed"; reason: PassLockReason; canBuy: boolean }
```

Reusing `ended` was rejected: its panel renders the rung name, the
purchase receipt date and a ticket stub
(`upgrade/page.tsx:539-600, 903-955`), all three of which would be
invented for a pass that never existed.

Placement is load-bearing. `closed` must gate **both** offer arms:

- the ordinary community offer (`hasPass` false, plan unpaid), and
- the **#327 `beyondPlan` offer** — a paid-plan org with no pass and
  exceeding rungs currently returns `{kind:"offer", beyondPlan:true}`
  even for a locked competition, and that Buy button 410s exactly like
  the community one. **Suppressing only the community path leaves this
  one live.** This case is absent from issue #376.

Resolution order in `upgradePageState`:

```
paidPlan && locked            → paid_plan     (no beyondPlan offer)
paidPlan && !locked && rungs  → offer{beyondPlan}
paidPlan                      → paid_plan
!hasPass && locked            → closed
hasPass                       → ended | ceiling | owned   (unchanged)
otherwise                     → offer
```

**5. `sellableRungs` is `[]` when locked.** `passState` returns no
sellable rungs for a closed competition, so no surface can render a rung
column it cannot sell.

**6. The route comment is now stale.** `pass-checkout/route.ts:161-162`
says "THE ROUTE IS THE AUTHORITY, even though the offer surfaces now
suppress this". They did not, for a never-held competition. The comment
is corrected; the route's own refusal stays exactly as it is — a
suppressed button is a nicety, refusing the money is the rule.

### New copy (part A)

| key | en |
| --- | --- |
| `pass.entry.closed.updateEndDate` | Update the end date |
| `upgrade.closed.title` | This competition is closed to Event Passes |
| `upgrade.closed.reasonTerminal` | This competition is finished or archived, so an Event Pass can no longer be bought for it. |
| `upgrade.closed.reasonPastEnds` | This competition is past its end date, so an Event Pass can no longer be bought for it. Update the end date if it is still running. |

All four keys in `en`, `es`, `fr`, `nl`. The existing
`pass.entry.ended.reason*` strings are **not** reusable: every one of them
says "its Event Pass has stopped lifting its limits", which is a lie
about a pass nobody bought.

## Part B — a mandatory, changeable end date

### Why

`passLockReason` (`apps/web/src/lib/entitlements.ts:181`) returns `null`
when `ends_on` is null. A competition with no end date can therefore
**never** reach `past_ends_on`; only a terminal status locks it. The
field being optional is the single reason the date arm of the pass line
rarely fires, and the same null makes a live competition hold a
`competitions.max_active` slot indefinitely.

### The design

- `CreateCompetition.ends_on` (`apps/web/src/server/api-v1/schemas.ts:44`)
  changes from `z.iso.date().nullish()` to required `z.iso.date()`.
- `PatchCompetition.ends_on` (`schemas.ts:71`) changes from
  `z.iso.date().nullable()` to `z.iso.date()`. The object stays
  `.partial()`, so the field remains **optional to send** — that is what
  "changeable" means — but it may no longer be set back to `null`.

  **This half is the point.** A mandatory create with a nullable PATCH is
  theatre: an org could PATCH `ends_on: null` and the competition would
  never cross the pass line again. That is the same evasion shape as part
  C — a write that buys its way out of a limit — and it must close in the
  same change.
- Cross-field validation: `ends_on >= starts_on`, enforced in the zod
  schema (so both the form and the public API get it) with a message key.
  Neither form validates this today.
- The column stays **nullable** in `V207__competitions.sql`. Greenfield,
  no production data, so no backfill is owed; a `NOT NULL` migration
  would buy nothing the schema-level requirement does not already give,
  and inventing dates for rows is exactly what silently expires a pass.
- Forms: `competition-wizard.tsx:129` (create) marks the field required;
  `competition-settings.tsx:276-283` (edit) keeps it editable and adds
  the same validation message.

### Blast radius (accepted)

Every fixture, factory, seed and e2e path that creates a competition
without `ends_on` breaks at once. **Owner decision: fix them all in this
pass.** A test factory that silently supplies a default would hide the
new requirement from every test that ought to be asserting it.

### New copy (part B)

| key | en |
| --- | --- |
| `comp.wizard.endsOn.required` | An end date is required. |
| `comp.validation.endsBeforeStarts` | The end date cannot be before the start date. |

## Part C — a played division keeps its quota slot

### Why

`apps/web/src/server/usecases/divisions.ts:110-114` counts only
`archived_at is null`, with a comment saying so deliberately: "Archived
divisions don't count — archiving frees the slot (v3/09 §4)."

Community's real bite is **1 division per competition**. So: create a
division, play it, archive it, create another — unlimited divisions
serially, inside one competition, paying nothing.

The guard already exists **on the other door**. `deleteDivision`
(`divisions.ts:276-298`) refuses a played division with
`DIVISION_HAS_RESULTS`, on the predicate
`status !== "setup" || decided > 0`, where `decided` counts `fixtures`
with `status in ('decided','finalized','forfeited')`
(`db/migration/v2-engine/tables/V214__fixtures.sql:4-25`). Archive is a
delete that skips delete's own guard **and** hands back a slot.

`restoreDivision` (`divisions.ts:359-368`) already re-checks the quota, so
the restore direction is closed. Only archive leaks.

### The design

A quota slot is burned by **a recorded result**, and by nothing else:

```sql
-- V354__division_has_results.sql
create or replace function division_has_results(p_division_id uuid)
  returns boolean
  language sql stable as $$
    select exists (
      select 1 from fixtures f
       where f.division_id = p_division_id
         and f.status in ('decided','finalized','forfeited'))
  $$;

create index if not exists fixtures_division_results_idx
  on fixtures (division_id)
  where status in ('decided','finalized','forfeited');
```

`STABLE`, not `IMMUTABLE` — unlike `pass_applies` (V343), which takes
scalars and touches no table, this one reads `fixtures`. **SECURITY
INVOKER** (the default) is deliberate: RLS on `fixtures` then applies to
the caller, and both call sites already run inside `withTenant`, so a
division belonging to another org is invisible either way. Next free
migration number is **V354** (`db/migration/deltas/` ends at V353).

Deliberately **narrower than delete's predicate**. Delete is broad
(`status <> 'setup' OR decided > 0`) because it destroys data. The slot
rule is not destroying anything, and merely *publishing* a division and
then realising the sport or variant is wrong is a mistake, not usage —
burning a paid slot for it is the unfairness the rule exists to avoid.

Two named predicates over one shared atom, not two copies of one rule:

- `deleteDivision` keeps its meaning: `status <> 'setup' OR
  division_has_results(id)` — its inline `exists` subquery is **replaced
  by the function call**, so there is exactly one definition of "has
  results" in the codebase. (This repo's recurring defect is a
  placer/verifier fork of one rule; the SQL-function precedent is
  `pass_applies`, V343.)
- the quota count becomes:

```sql
select count(*)::int as n from divisions d
where d.competition_id = $1
  and (d.archived_at is null or division_has_results(d.id))
```

No cutoff timestamp: greenfield, no production data, so a "from now on"
comparison would be dead complexity.

**No timer.** A window measured from creation is the only variant that
targets mistakes rather than usage, and even 48–72h is churnable by a
weekend-tournament org — precisely the customer who should be paying. A
timer long enough to close the loop punishes honest mistakes; one short
enough to spare them reopens it.

### Market check

No dominant convention exists. General SaaS splits between refund-on-
removal (GoHighLevel renews the site-project quota on delete — today's
seazn behaviour, the churnable one) and no-refund (Moqups keeps archived
projects inside the quota: restore within your limit, but you cannot
archive your way to a new one; Supabase exempts only *paused* projects, a
reversible state). Moqups is the closest analogue to this design.

The sports vendors mostly sidestep the question by metering something
non-recyclable — LeagueRepublic counts unique teams in divisions **within
a season**. Recorded worth recording, out of scope to act on: this
evasion exists because the quota sits on a recyclable *container* (a
division) rather than an accumulating *event*. Burning the slot on a
recorded result is what converts the container metric into an event
metric at the point where it matters.

### The escape hatch

An org can burn a slot by genuine accident — one stray recorded result.
A rule with a support path beats a rule with a timer that doubles as a
loophole.

A staff-only control in `/admin` clears a division's slot consumption,
writing an audit entry. Per the standing rule `/admin` is a functional
bar — no design polish, but it must work at 375px.

Implementation: a nullable `divisions.slot_waived_at timestamptz` (plus
`slot_waived_by`), and the quota predicate becomes
`archived_at is null or (division_has_results(id) and slot_waived_at is
null)`. Greenfield, so a new column is preferred over encoding this in
an existing one.

### Honesty at the point of action

Two surfaces must tell the truth **before** the org acts, not after:

1. The archive confirmation warns, when the division has results, that
   archiving will not return the slot.
2. The `402` from `PaymentRequiredError("divisions.per_competition.max")`
   must explain *why* the org is at its limit when it can see an archived
   division — a bare paywall for an invisible cause is the same class of
   defect as part A.

### New copy (part C)

| key | en |
| --- | --- |
| `division.archive.slotWarning` | This division has recorded results, so archiving it will not free a division slot. |
| `division.limit.archivedCount` | Divisions with recorded results count toward your limit even after they are archived. |

## Part D — a terminal competition accepts no new divisions

### Why

`assertCompetitionNotFrozen` (`entitlement-freeze.ts:91-99`) checks only
the over-quota freeze; it says nothing about status. So a `completed` or
`archived` competition **accepts new divisions today**.

This is not a quota leak — `divisions.per_competition.max` still binds at
2 for community regardless of status — but it makes "completed"
meaningless, and it contradicts every other rule on this seam: the same
competition cannot be sold an Event Pass (part A) yet can still grow new
divisions.

### The design

`createDivision` and `restoreDivision` refuse when the competition holds
a terminal status, using part A's vocabulary rather than a fresh status
list:

```ts
if (passLockReason(comp.status, comp.ends_on) === "terminal")
  throw new HttpError(409, "…");
```

**`terminal` only, deliberately.** The `past_ends_on` arm must NOT block
writes: that arm is frequently just a stale end date on a competition
still being played (the whole reason part A points that organiser at
settings), and refusing division creation there would break live
competitions over a typo. The pass line and the write line share a
vocabulary, not a threshold.

Scoped to divisions. A terminal competition rejecting *every* structural
write is the more correct lifecycle, but the blast radius is repo-wide
and out of this branch's remit.

### New copy (part D)

| key | en |
| --- | --- |
| `division.create.competitionEnded` | This competition is finished, so no new divisions can be added to it. |

## Competition slots — answered, unchanged

A `completed`/`archived` competition **frees** its
`competitions.max_active` slot: `assertActiveQuota`
(`competitions.ts:88-95`) counts only
`ACTIVE_COMPETITION_STATUSES = ["draft","published","live"]`
(`entitlement-freeze.ts:14`). Community is seeded at **1 active
competition, 2 divisions per competition**
(`V270__pricing_v3_matrix.sql:7-8`).

The community promise is therefore *one live competition with two
divisions, as many seasons as you like, serially* — a concurrency cap,
not a lifetime one.

This does not undermine part C. The division cap is **per competition**,
so a new competition legitimately earns its own 2 slots — and the org
pays for it in product terms: a new URL, a new identity, no standings
continuity, entrants re-entered. Archiving a division inside a live
competition costs them none of that. Part C closes the free path and
leaves the expensive one open, which is where the line belongs.

## Testing

Every part ships **four** kinds, per the standing rule. A part is not
done until all four exist and pass.

| part | unit | regression (fails without the change) | e2e (Playwright) | smoke |
| --- | --- | --- | --- | --- |
| A | `upgrade-page-state.test.ts` — `closed` for every `(hasPass, lockReason, paidPlan, exceedingRungs)` combination, **including paid-plan + locked + exceeding rungs**; `competition-pass-provider.test.tsx` — precedence of all five states | a locked never-held competition renders **no** `[data-pass-entry]`, and `/upgrade` renders no checkout control | organiser opens a completed competition → no buy chip → `/upgrade` shows the closed panel, both reasons | demo covers a completed competition with no pass |
| B | schema tests: create without `ends_on` rejected; PATCH `null` rejected; PATCH to a new date accepted; `ends_on < starts_on` rejected | a competition created through the API without an end date is refused | wizard blocks submit without an end date; settings changes it | demo seeds carry end dates |
| C | quota counting with archived-played, archived-unplayed, live; `division_has_results` true only for decided/finalized/forfeited | archive a played division → creating another 402s; archive an unplayed one → creating another succeeds | community org archives a played division and is refused a new one, with the explaining copy | demo shows an archived played division still counted |
| D | create/restore refused on `completed` and on `archived`; **accepted on `past_ends_on`** (the arm that must not block) | adding a division to a completed competition 409s | organiser completes a competition, then cannot add a division | demo covers a completed competition |

Assertions on Next HTML must anchor on `="` — React serialises an omitted
prop as `"$undefined"`, so a bare `data-*` probe passes in both states.

## Gates before commit

- `openapi:gen` **and** `i18n:gen-keys`, then `git status --porcelain`
  must be empty. Both are CI-only drift gates and both have bitten this
  repo repeatedly. Part B changes `schemas.ts`, so OpenAPI **will** drift.
- All new/changed strings in `en`, `es`, `fr`, `nl`.
- UI verified at desktop and 375px with no horizontal page scroll.
- Help pages updated where behaviour changes (`content/help/**`, one
  English tree, no i18n owed).

## Out of scope

`competitions.max_active` (`competitions.ts:79-99`) deliberately excludes
completed/archived competitions. It is a **concurrency** cap, named as
one, and serial reuse is the intended product shape there. It is not a
leak and is not touched.
