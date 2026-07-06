import "server-only";
import { sql, withTenant } from "@/lib/db";
import { foldFixture, type FoldedFixture } from "./fold";

// Deep structural equality, order-independent for object keys — compares a
// freshly-folded state to the jsonb round-tripped snapshot (Postgres normalises
// jsonb key order, so a plain JSON.stringify would false-positive).
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (typeof a === "object") {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const ak = Object.keys(ao);
    const bk = Object.keys(bo);
    if (ak.length !== bk.length) return false;
    return ak.every((k) => Object.hasOwn(bo, k) && deepEqual(ao[k], bo[k]));
  }
  return false;
}

/**
 * Rebuild a fixture's match_state cache from its ledger and reconcile the
 * fixture's denormalized outcome/status. A consistency-repair / migration tool
 * (spec 03 §5). Returns the folded result, or null if the fixture has no events.
 */
export async function rebuildState(
  orgId: string,
  fixtureId: string,
): Promise<FoldedFixture | null> {
  return withTenant(orgId, async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${"fixture:" + fixtureId}))`;
    const folded = await foldFixture(tx, fixtureId);
    if (!folded) return null;

    await tx`
      insert into match_states (fixture_id, last_seq, state, summary)
      values (${fixtureId}, ${folded.lastSeq}, ${tx.json(folded.state as never)},
              ${tx.json(folded.summary as never)})
      on conflict (fixture_id) do update set
        last_seq = excluded.last_seq, state = excluded.state,
        summary = excluded.summary, updated_at = now()
    `;

    if (folded.outcome !== null) {
      await tx`
        update fixtures set outcome = ${tx.json(folded.outcome as never)}
        where id = ${fixtureId} and outcome is null
      `;
    }
    return folded;
  });
}

export interface ConsistencyReport {
  checked: number;
  mismatches: { fixtureId: string; reason: string }[];
}

/**
 * Refold N random fixtures and compare against their stored match_state
 * snapshots (spec 03 §5 — cron/CI drift detector). Samples across all orgs via
 * the superuser connection, then refolds each under its tenant context.
 */
export async function verifyStateConsistency(sampleSize = 20): Promise<ConsistencyReport> {
  const sample = await sql<{ fixture_id: string; org_id: string }[]>`
    select f.id as fixture_id, f.org_id
    from fixtures f join match_states m on m.fixture_id = f.id
    order by random() limit ${sampleSize}
  `;

  const mismatches: ConsistencyReport["mismatches"] = [];
  for (const { fixture_id, org_id } of sample) {
    await withTenant(org_id, async (tx) => {
      // Serialise against in-flight appends (same lock as appendEvent):
      // without it the ledger read and the match_states read can straddle a
      // concurrent commit and report a false last_seq drift.
      await tx`select pg_advisory_xact_lock(hashtext(${"fixture:" + fixture_id}))`;
      // A drift detector must report, not crash: a ledger that no longer folds
      // (tampered/corrupt rows) is itself the finding.
      let folded: FoldedFixture | null;
      try {
        folded = await foldFixture(tx, fixture_id);
      } catch (err) {
        mismatches.push({
          fixtureId: fixture_id,
          reason: `refold failed: ${err instanceof Error ? err.message : String(err)}`,
        });
        return;
      }
      const [stored] = await tx<{ last_seq: number; state: unknown }[]>`
        select last_seq, state from match_states where fixture_id = ${fixture_id}
      `;
      if (!folded || !stored) {
        mismatches.push({ fixtureId: fixture_id, reason: "missing state or ledger" });
        return;
      }
      if (folded.lastSeq !== stored.last_seq) {
        mismatches.push({
          fixtureId: fixture_id,
          reason: `last_seq ${stored.last_seq} != folded ${folded.lastSeq}`,
        });
      } else if (!deepEqual(folded.state, stored.state)) {
        mismatches.push({ fixtureId: fixture_id, reason: "state snapshot diverged from fold" });
      }
    });
  }
  return { checked: sample.length, mismatches };
}
