import "server-only";
import type postgres from "postgres";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/http";
import {
  LOCKED_FIXTURE_STATUSES,
  fixtureStatusFromFold,
  recomputeStandings,
  resolveFixtureCfg,
} from "@/server/engine-db";
import { foldFixture } from "@/server/engine-db/fold";

/**
 * THE ESCAPE HATCH FROM THE V347 CONFIG SNAPSHOT.
 *
 * The snapshot freezes the resolved cfg a fixture was scored under so a later
 * config edit cannot rescore it or make it unreadable. That is the right default
 * and it has an obvious failure mode: an organiser who genuinely set the WRONG
 * config before scoring started is now frozen into it, and the natural fix —
 * edit the division — silently does nothing. Shipping the freeze without a way
 * out would just convert one class of unrecoverable state into another.
 *
 * So staff can re-freeze one fixture from live config. Three constraints, each
 * load-bearing:
 *
 *  1. AUDITED. One `staff_audit_log` row per re-snapshot, carrying the reason
 *     and BOTH configs — nothing else keeps the cfg that is being discarded, so
 *     the audit row has to be enough on its own to reconstruct what the fixture
 *     used to fold against.
 *  2. REOPENED ONLY. Refused on exactly `LOCKED_FIXTURE_STATUSES`, the set the
 *     ledger itself guards appends on. Rewriting the cfg under a finalized
 *     result is precisely the harm the snapshot exists to prevent; staff must
 *     reopen the fixture first, which is a visible act with its own trail.
 *     The check is re-read inside the transaction under the fixture advisory
 *     lock, because a guard read before the lock is not a guard.
 *  3. SUPERADMIN, enforced at the route (`requireSuperadmin`) — the discarded
 *     config survives only in the audit row this writes, which is a higher bar
 *     than reading `/admin/fixtures`. Pinned by a route test; plain
 *     `requireStaff` would be a silent downgrade.
 *
 * The write and its audit row commit TOGETHER, so a crash can never leave a
 * re-snapshotted fixture with no record of who did it. `sql.begin` rather than
 * `withTenant`: this is a staff action across orgs, and `staff_audit_log` is not
 * an org-scoped table. Mirrors `logStaffAction`'s columns inline rather than
 * calling it — that helper opens its own connection and would land outside this
 * transaction (same reasoning as `admin-plan.ts`).
 */

export interface FixtureConfigPanel {
  fixtureId: string;
  fixtureNo: number | null;
  status: string;
  orgName: string;
  competitionName: string;
  divisionName: string;
  sportKey: string;
  eventCount: number;
  /** The frozen cfg, or null for a fixture that has never been scored. */
  snapshot: unknown;
  snapshotAt: string | null;
  /** What the fixture WOULD fold against if it were scored for the first time
   *  right now — division config with the stage decider overlay applied. */
  live: unknown;
  /** The whole reason this page exists: the two disagree. */
  diverged: boolean;
  canResnapshot: boolean;
}

interface Row {
  id: string;
  org_id: string;
  stage_id: string;
  pool_id: string | null;
  fixture_no: number | null;
  status: string;
  config_snapshot: unknown;
  config_snapshot_at: Date | null;
  division_config: unknown;
  stage_config: Record<string, unknown> | null;
  sport_key: string;
  division_name: string;
  competition_name: string;
  org_name: string;
  event_count: number;
}

/** Pooled `sql` or an open transaction — `postgres.TransactionSql` and `Sql`
 *  share `ISql`. Which one matters: the guards must run on the TX. */
type Queryable = postgres.ISql;

async function loadRow(db: Queryable, fixtureId: string): Promise<Row | null> {
  const [row] = await db<Row[]>`
    select f.id, f.org_id, f.stage_id, f.pool_id, f.fixture_no, f.status,
           f.config_snapshot, f.config_snapshot_at,
           d.config as division_config, s.config as stage_config, d.sport_key,
           d.name as division_name, c.name as competition_name, o.name as org_name,
           (select count(*)::int from score_events e where e.fixture_id = f.id) as event_count
    from fixtures f
    join divisions d on d.id = f.division_id
    join stages s on s.id = f.stage_id
    join competitions c on c.id = d.competition_id
    join organizations o on o.id = c.org_id
    where f.id = ${fixtureId}`;
  return row ?? null;
}

/** Everything `/admin/fixtures` renders. Null when the id matches nothing —
 *  staff paste ids from support tickets, so a typo must not 500. */
export async function fixtureConfigPanel(fixtureId: string): Promise<FixtureConfigPanel | null> {
  const row = await loadRow(sql, fixtureId);
  if (!row) return null;
  // `resolveFixtureCfg(null, …)` rather than a second call to stageScopedCfg:
  // "what live config resolves to" must have ONE definition, or the divergence
  // shown here could differ from the one the fold would actually see.
  const live = resolveFixtureCfg(null, row.division_config, row.stage_config);
  const snapshot = row.config_snapshot;
  return {
    fixtureId: row.id,
    fixtureNo: row.fixture_no,
    status: row.status,
    orgName: row.org_name,
    competitionName: row.competition_name,
    divisionName: row.division_name,
    sportKey: row.sport_key,
    eventCount: row.event_count,
    snapshot,
    snapshotAt: row.config_snapshot_at?.toISOString() ?? null,
    live,
    diverged: snapshot !== null && JSON.stringify(snapshot) !== JSON.stringify(live),
    canResnapshot: snapshot !== null && !LOCKED_FIXTURE_STATUSES.has(row.status),
  };
}

/** Re-freeze a REOPENED fixture's cfg from live division + stage config. */
export async function resnapshotFixtureConfig(
  actorId: string,
  fixtureId: string,
  reason: string,
): Promise<void> {
  const trimmed = reason.trim();
  if (trimmed.length === 0) {
    throw new HttpError(400, "Say why — the audit row is the only record of the discarded config.");
  }
  const row = await sql.begin(async (tx) => {
    // FIRST statement in the transaction, and the SAME lock `append-event.ts`
    // serialises every append on. Without it the guards below were evaluated
    // against a row read on another connection before the tx opened, so a
    // `core.finalize` committing in that window let staff rewrite the config
    // under a finalized result — the one thing this feature forbids. Holding it
    // to commit means an append that wants in blocks and then re-reads.
    await tx`select pg_advisory_xact_lock(hashtext(${"fixture:" + fixtureId}))`;
    // Re-read ON THE TX, under the lock. Every guard, and the audit row's
    // `before`, must come from this row and not from a pre-transaction read:
    // an audit entry claiming a config was discarded that never was is worse
    // than no entry at all.
    const row = await loadRow(tx, fixtureId);
    if (!row) throw new HttpError(404, "Fixture not found");
    if (LOCKED_FIXTURE_STATUSES.has(row.status)) {
      throw new HttpError(
        409,
        `This fixture is ${row.status}. Reopen it before rewriting the config it was scored under.`,
      );
    }
    if (row.config_snapshot === null) {
      throw new HttpError(
        409,
        "This fixture has no config snapshot yet — it already folds against live config.",
      );
    }

    const live = resolveFixtureCfg(null, row.division_config, row.stage_config);
    await tx`
      update fixtures
      set config_snapshot = ${tx.json(live as never)}, config_snapshot_at = now()
      where id = ${fixtureId}`;
    // PREFLIGHT, inside the transaction and AFTER the write so it reads the new
    // snapshot through the ordinary read path. Live config is not guaranteed to
    // be compatible with history that was recorded under something else — the
    // hatch would otherwise be a one-click way to reproduce the exact bug the
    // snapshot exists to escape, on a fixture staff were trying to rescue. A
    // throw here rolls the update back, so a refused re-snapshot leaves both the
    // old cfg and an empty audit trail.
    let folded;
    try {
      folded = await foldFixture(tx, fixtureId);
    } catch (err) {
      throw new HttpError(
        409,
        "The live config cannot read this fixture's recorded events " +
          `(${err instanceof Error ? err.message : "fold failed"}). ` +
          "Fix the division config first, then re-snapshot.",
      );
    }
    // …and the preflight's answer is KEPT, not thrown away. Every fold-derived
    // cache on this fixture was computed under the config just discarded:
    // `match_states` (what `/state`, the score page and the console all read —
    // no read path re-folds), `fixtures.outcome` and `fixtures.status`. Leaving
    // them meant the panel reported `diverged: no` over a fixture still showing
    // the old config's result, until somebody happened to append another event.
    if (folded) {
      await tx`
        insert into match_states (fixture_id, last_seq, state, summary)
        values (${fixtureId}, ${folded.lastSeq}, ${tx.json(folded.state as never)},
                ${tx.json(folded.summary as never)})
        on conflict (fixture_id) do update set
          last_seq = excluded.last_seq, state = excluded.state,
          summary = excluded.summary, updated_at = now()`;
      // Unconditionally, in BOTH directions: a corrected config can just as
      // easily un-decide a fixture (tennis at bestOf 5 is not over after two
      // sets) as decide one, and a stale non-null outcome beside a null fold is
      // what feeds the standings table.
      await tx`
        update fixtures set
          outcome = ${folded.outcome === null ? null : tx.json(folded.outcome as never)},
          status = ${fixtureStatusFromFold(folded.outcome, folded.active)}
        where id = ${fixtureId}`;
    }
    // Mirror logStaffAction's columns (lib/admin.ts) on THIS tx — never call
    // logStaffAction itself inside the tx, it opens its own connection.
    await tx`
      insert into staff_audit_log (actor_id, action, target_type, target_id, detail)
      values (${actorId}, 'fixture_config_resnapshot', 'fixture', ${fixtureId}, ${tx.json({
        reason: trimmed,
        status: row.status,
        event_count: row.event_count,
        before: row.config_snapshot,
        after: live,
      } as never)})`;
    return row;
  });

  // AFTER commit, and outside the transaction on purpose: `recomputeStandings`
  // opens its own tenant connection and takes the DIVISION advisory lock, which
  // cannot be acquired from inside a tx already holding the fixture lock without
  // inverting the order every other writer uses. The standings snapshot is a
  // derived cache — `usecases/scoring.ts` recomputes it after its own append the
  // same way — so a crash here leaves a stale table, not a wrong ledger, and the
  // next scored fixture in the stage repairs it.
  await recomputeStandings(row.org_id, row.stage_id, row.pool_id ?? undefined);
}
