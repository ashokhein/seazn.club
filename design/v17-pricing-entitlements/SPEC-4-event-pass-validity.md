# v17/SPEC-4 — Event Pass Validity (auto-lock, no carry to next edition)

Absorbs GitHub issues **#248 (SPEC)** and children **#249–#252** into the v17 home. This is the *lifecycle* half of Event Pass (when a pass stops applying); the *matrix* half (what a pass lifts) is in [`SPEC-1 §5`](./SPEC-1-plan-entitlement-matrix.md) and the *size ladder* in [`SPEC-2 §4`](./SPEC-2-addons-and-ai-credit-wallet.md).

**UI surfaces:** SPEC-6 §A7 (Pass M/L buy), §A8 (Pass ended → next-edition).

---

## 1. Purpose

Enforce Event Pass validity **automatically** — match competitor patterns (esp. Tournify) and close the gap between help copy ("for as long as it runs / doesn't carry to next year's edition") and what the resolver actually does today.

## 2. Problem — help promises, code half-delivers

| Promise | Enforced? | How |
|---|---|---|
| Scoped to one competition | ✅ Yes | `competition_passes.competition_id` PK |
| New competition = new Pass | ✅ Yes (if they create a new row) | new UUID → no pass row |
| "Until it ends" | ❌ **No** | resolver never checks `status` / `ends_on` / age |
| Can't reuse Year-1 forever by renaming | ❌ **No** | name/slug editable; ID immutable; pass stays |

**Abuse:** buy Pass on "Summer Cup 2026", keep status live, rename to "Summer Cup 2027" in 2027 → still entitled. Competition ID can't be edited; name can.

## 3. Current implementation (source of truth)

**Schema** — `db/migration/deltas/V271__competition_passes.sql`:

```
competition_passes(
  competition_id  uuid PK → competitions(id),
  org_id, pass_key default 'event_pass',
  stripe_payment_intent, purchased_at
)
```

- One pass per competition (PK). No `expires_at`, no `locked_at`, no status join. Comment says upgrades one competition for its **lifetime**.

**Resolver** — `apps/web/src/lib/entitlements.ts`: order `override → Event Pass (community only, if competitionId) → plan → deny`. Pass arm joins `competition_passes` + `plan_entitlements` by `competition_id` + `org_id`. **No lifecycle check.**

**Mutable vs immutable:**

| Field | Mutable? | Affects Pass? |
|---|---|---|
| `id` | ❌ | pass is keyed on this |
| `name` / `slug` | ✅ | no — rename keeps pass |
| `status` (`draft` / active / `completed` / `archived`) | ✅ | not consulted by pass resolver |
| `starts_on` / `ends_on` | ✅ | not consulted by pass resolver |

Passed comps are already excluded from `competitions.max_active` counting; entitlement expiry is not.

## 4. Competitor patterns (how others auto-enforce)

| Mechanism | Stops | Used by |
|---|---|---|
| Bind to competition ID | Pass A ≠ Comp B | almost everyone (us ✅) |
| **Lock when completed / archived** | reusing Year-1 into 2027 | Tournify-style |
| Copy / new season → new ID | name reuse without pay | product UX |
| Calendar safety cap | endless "still live" without completing | time-boxed plans |
| Cap active comps | hoarding unfinished events | free tiers (we have `competitions.max_active`) |

**Verdict:** peers don't primarily sell "valid 3 months." They sell **one tournament**, then **lock it** so the next edition is a new purchase. Tournify: after you organize it, the event is **locked** (stays visible); copy for next year = new upgrade.

## 5. Goals / non-goals

**Goals:** make help copy true in code; finished event stays readable but paid-for-running features stop/freeze after end; keep "new competition = new Pass" obvious; don't punish legitimate long (multi-month) events; keep Pass surviving Pro downgrade for the *active* run.

**Non-goals:** changing Pass price/matrix (SPEC-1/2); deleting historical data on lock; making Pass transferable across competitions.

## 6. Options considered

| Option | Rule | Trade-off |
|---|---|---|
| **A** status lock | lock when `status ∈ {completed, archived}` | matches Tournify; but organizer can leave status active forever |
| **B** `ends_on` lock | lock when `ends_on + grace < today` | calendar-automatic; but `ends_on` optional/editable → gameable |
| **C** N-month cap | lock at `purchased_at + N` | hard stop; but punishes real long events; worse messaging |
| **D** soft UX only | "duplicate season" CTA, no resolver change | cheap; doesn't enforce |
| **E** **hybrid** | A primary + B secondary + C safety-net + UX | recommended |

## 7. Recommended — hybrid (E)

1. **A primary:** lock Pass overlay when competition is terminal (`completed`/`archived`).
2. **B secondary:** if `ends_on` set and past (+ grace, propose **7 days**), treat as locked even if status stale.
3. **C safety-net (optional, #252):** `purchased_at + 12 months` — **12, not 3** (3 punishes multi-month leagues); defer-able.
4. **UX (#250):** archive/complete CTAs + "Create next year's edition" (new ID) + copy-competition requires a new Pass.

### Resolver rule (conceptual) — #249

When resolving Event Pass for `(orgId, competitionId, featureKey)`:

```
1. find competition_passes row (unchanged)
2. load competition lifecycle: status, ends_on, purchased_at
3. isPassLocked = status ∈ {completed, archived}
                  OR (ends_on set AND ends_on + grace < today)
                  OR (optional) purchased_at + 12mo < now
4. locked?  → ignore pass overlay, fall through to Community plan row
   else     → apply pass overlay as today
```

**Do not** revoke the `competition_passes` row on lock — keep money/audit/invoice history. Lock is a **runtime eligibility** check. Refund/chargeback still deletes the row (unchanged).

## 8. What "locked" means for the organiser

| Surface | Behavior |
|---|---|
| Public / shared pages | stay up (read) |
| Entrants/divisions over free caps | **freeze** (like downgrade) — no delete |
| New divisions/entrants over Community caps | blocked (402 / upgrade CTA) |
| Branded exports, sponsors, realtime from Pass | off once locked |
| Platform fee | back to plan rate for *new* charges |
| Billing "Event Pass purchases" list | still listed; badge **Active** vs **Ended** |

## 9. Next-edition UX — #250

- CTA on passed competition near end / locked: **Create next year's edition** → new competition (new UUID), no Pass carried.
- Any duplicate/copy-competition path must **not** copy `competition_passes`.
- Rename alone never creates a new Pass requirement (correct); completing + creating new does.
- Billing pass list: **Active** vs **Ended** badge (`usecases/billing-manage.ts`).

## 10. "Still live in 2027" without completing

Layered mitigations: help/UI nudge to mark complete → `ends_on` secondary lock → optional 12-mo safety cap → existing `competitions.max_active` pressure. Once locked/terminal, treat like completed (don't consume an active slot; overlay off).

## 11. Help copy — #251

Update `apps/web/content/help/billing/event-pass.md`: lock triggers (status, `ends_on` + grace, optional max duration if #252 ships). Explicit: **rename ≠ new edition**; **new competition row = new Pass**. Remove any unqualified "lifetime forever."

## 12. Interaction with v17 size ladder

The Event Pass **M/L** ladder (SPEC-2 §4a) is **two pass plan_keys** — `competition_passes.pass_key` is `event_pass` (M) or `event_pass_l` (L); the lock is on the row, **rung-agnostic**. A locked pass of either rung falls back to Community caps. The size a pass *granted* is irrelevant once locked. Size-pack add-ons bought by subscribers follow the **same** competition lifecycle lock.

## 13. Implementation sketch (when built — not now)

1. Prefer **compute-at-read** from `competitions.status` / `ends_on` + `purchased_at`; optional `competition_passes.locked_at` for analytics only.
2. `entitlements.ts` pass arm: apply `isPassLocked(...)`; unit tests for the lock matrix.
3. `usecases/competitions.ts` status transitions: emit `event_pass.locked` analytics (optional); no row delete.
4. `billing-manage.ts`: Active vs Ended list; upgrade page "Pass ended" state + next-edition / Pro CTAs.
5. Extend pass smoke in `scripts/smoke.ts` for one lock path.

## 14. Acceptance criteria

- [ ] Completed/archived comp with Pass row no longer receives Pass entitlements.
- [ ] Active comp with Pass unchanged; rename of active passed comp keeps Pass.
- [ ] New competition (new UUID), same name, has no Pass.
- [ ] Duplicate/copy competition does not copy the Pass row.
- [ ] Refund still revokes the Pass row entirely.
- [ ] Help + upgrade + billing list show Active / Ended correctly.
- [ ] Resolver lock matrix tested; smoke covers one lock path.
- [ ] Decision recorded on the 12-month safety cap (ship or defer).

## 15. Open questions (product call)

1. Terminal statuses exactly — `completed` + `archived` only, or others?
2. Grace after `ends_on` — 0 / 7 / 14 days?
3. Ship 12-month `purchased_at` cap in v1 or defer (#252)?
4. After lock, can org **renew** Pass on the same competition ID, or must create new?
5. Platform fee on late payments after lock — plan rate immediately?
6. Should locking auto-set status if only `ends_on` passed?

## 16. Child issue map

| Issue | Section | Priority |
|---|---|---|
| #248 | this SPEC (parent) | — |
| #249 lock on status + `ends_on` | §7 resolver rule | P1 |
| #250 next-edition UX | §9 | P1 |
| #251 help copy | §11 | P2 |
| #252 12-month safety cap | §7.3 (optional) | P2 |

## 17. Related code / docs

`db/migration/deltas/V271__competition_passes.sql` · `apps/web/src/lib/entitlements.ts` (pass arm) · `apps/web/src/lib/billing.ts` (grant/revoke/metadata) · `usecases/competitions.ts` · `usecases/billing-manage.ts` · `apps/web/content/help/billing/event-pass.md` · `design/v3/07-pricing-packaging-v3.md`
