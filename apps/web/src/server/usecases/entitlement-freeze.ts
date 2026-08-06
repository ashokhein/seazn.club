import "server-only";
// Downgrade behaviour (doc 10 §2.4): existing data is NEVER deleted; resources
// over the new plan's quota become read-only, flagged `frozen` in read models.
// Which N stay active is decided in exactly one place — the selector below:
// most recently active first (last score event, else creation time).
import type postgres from "postgres";
import { withTenant } from "@/lib/db";
import { getLimit } from "@/lib/entitlements";
import { PaymentRequiredError } from "@/lib/errors";

type Tx = postgres.TransactionSql;

// Competition statuses that count against `competitions.max_active`.
export const ACTIVE_COMPETITION_STATUSES = ["draft", "published", "live"] as const;

export interface FreezeCandidate {
  id: string;
  lastActiveAt: string | Date;
}

/**
 * Pure freeze selector: given all candidates and the plan limit, return the
 * ids that must freeze. Keeps the `limit` most recently active; ties break on
 * id so the same inputs always freeze the same rows. limit null = unlimited.
 */
export function selectFrozen(
  candidates: readonly FreezeCandidate[],
  limit: number | null,
): Set<string> {
  if (limit === null || candidates.length <= limit) return new Set();
  const sorted = [...candidates].sort((a, b) => {
    const ta = new Date(a.lastActiveAt).getTime();
    const tb = new Date(b.lastActiveAt).getTime();
    if (ta !== tb) return tb - ta; // most recently active first
    return a.id < b.id ? -1 : 1;
  });
  return new Set(sorted.slice(Math.max(limit, 0)).map((c) => c.id));
}

// Activity = latest score event anywhere in the competition, else created_at.
// Passed competitions (v3/07 §3) are excluded here AND from the count below:
// an Event Pass buys that competition out of the active-comp quota for its
// lifetime — which ENDS at the grace boundary (SPEC-4 §7). This used to read
// "a pass row exists", so the exemption never ended (#347): a `live`
// competition past its ends_on + grace was immune to freezing for ever.
// V343's pass_applies is the same predicate the resolver uses.
async function loadCandidates(tx: Tx): Promise<FreezeCandidate[]> {
  const rows = await tx<{ id: string; last_active: string }[]>`
    select c.id,
           greatest(c.created_at, coalesce(max(e.recorded_at), c.created_at)) as last_active
    from competitions c
    left join divisions d on d.competition_id = c.id
    left join fixtures f on f.division_id = d.id
    left join score_events e on e.fixture_id = f.id
    where c.status in ${tx([...ACTIVE_COMPETITION_STATUSES])}
      and not exists (
        select 1 from competition_passes cp
         where cp.competition_id = c.id
           and pass_applies(c.status, c.ends_on, (now() at time zone 'utc')::date))
    group by c.id, c.created_at`;
  return rows.map((r) => ({ id: r.id, lastActiveAt: r.last_active }));
}

/**
 * The org's frozen competition ids (empty for in-quota orgs — the common case
 * costs one count query).
 *
 * MUST NOT be called from inside a `withTenant` callback. It opens with
 * `getLimit`, which queries the POOLED `sql` proxy on a cache miss; asking the
 * pool for a second connection while `withTenant` still pins the first is the
 * self-deadlock that hung production twice on 2026-08-05 (see
 * `__tests__/pool-nesting-tripwire.test.ts`). It used to take an optional `tx`
 * that looked like it made the nested case safe — it did not: `getLimit` runs
 * BEFORE the `tx` branch is ever reached, so every caller that threaded the
 * ambient transaction through was still nesting a pooled query. The parameter
 * is gone rather than fixed so the trap cannot be re-set; callers inside a
 * transaction resolve the set first and use `assertNotFrozen` below.
 */
export async function frozenCompetitionIds(orgId: string): Promise<Set<string>> {
  const limit = await getLimit(orgId, "competitions.max_active");
  if (limit === null) return new Set();
  const run = async (t: Tx): Promise<Set<string>> => {
    const [{ n }] = await t<{ n: number }[]>`
      select count(*)::int as n from competitions c
      where c.status in ${t([...ACTIVE_COMPETITION_STATUSES])}
        and not exists (
          select 1 from competition_passes cp
           where cp.competition_id = c.id
             and pass_applies(c.status, c.ends_on, (now() at time zone 'utc')::date))`;
    if (n <= limit) return new Set();
    return selectFrozen(await loadCandidates(t), limit);
  };
  return withTenant(orgId, run);
}

/**
 * The guard, split from the lookup: PURE, so it can be evaluated on a
 * competition id that only becomes known inside a transaction without dragging
 * a pooled query in there with it.
 *
 * The two-phase shape every write path now uses:
 *
 *     const frozen = await frozenCompetitionIds(auth.orgId);   // before the tx
 *     return withTenant(auth.orgId, async (tx) => {
 *       const [division] = await tx`select competition_id ...`;
 *       assertNotFrozen(frozen, division.competition_id);      // no I/O
 *     });
 *
 * The set is keyed on the ORG, not on the entity, so hoisting the lookup never
 * needs an id the transaction has not read yet, and the entity's own 404 still
 * fires first (an unknown id is never a member of the set).
 */
export function assertNotFrozen(frozen: ReadonlySet<string>, competitionId: string): void {
  if (frozen.has(competitionId)) {
    throw new PaymentRequiredError("competitions.max_active");
  }
}

/**
 * Write guard for anything living under a competition (divisions, stages,
 * entrants, scoring, edits). Frozen ⇒ 402 carrying the quota key, so the UI
 * shows the same contextual paywall as a blocked create.
 *
 * OUTSIDE a transaction only — see `frozenCompetitionIds`. Callers that already
 * hold the competition id before opening theirs keep using this; callers that
 * read the id inside use `frozenCompetitionIds` + `assertNotFrozen`.
 */
export async function assertCompetitionNotFrozen(
  orgId: string,
  competitionId: string,
): Promise<void> {
  assertNotFrozen(await frozenCompetitionIds(orgId), competitionId);
}

// ---------------------------------------------------------------------------
// Member seats (doc 13 §5 + doc 10 §2.4): after a downgrade an org can hold
// more owner/admin/viewer members than members.max allows. Nothing is
// deleted — over-quota members become effectively read-only (the freeze
// rule), owners exempt (an org must keep a working owner; the owner frees
// seats by demoting/removing). Same lazy selector as competitions, with
// membership age as the activity signal.
// ---------------------------------------------------------------------------

/** user_ids of members whose WRITE access is frozen by members.max. */
export async function frozenMemberIds(orgId: string): Promise<Set<string>> {
  const limit = await getLimit(orgId, "members.max");
  if (limit === null) return new Set();
  const rows = await withTenant(orgId, (tx) =>
    tx<{ user_id: string; role: string; created_at: string }[]>`
      select user_id, role, created_at from org_members
      where org_id = ${orgId} and role <> 'scorer'`,
  );
  if (rows.length <= limit) return new Set();
  const owners = rows.filter((r) => r.role === "owner");
  const rest = rows.filter((r) => r.role !== "owner");
  // Owners always stay active but still occupy seats.
  const restLimit = Math.max(limit - owners.length, 0);
  return selectFrozen(
    rest.map((r) => ({ id: r.user_id, lastActiveAt: r.created_at })),
    restLimit,
  );
}

/** 402 when this member's seat is frozen (doc 10 §2.4) — call on write auth. */
export async function assertMemberNotFrozen(orgId: string, userId: string): Promise<void> {
  const frozen = await frozenMemberIds(orgId);
  if (frozen.has(userId)) throw new PaymentRequiredError("members.max");
}
