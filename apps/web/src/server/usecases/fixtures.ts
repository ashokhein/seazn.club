import "server-only";
// Fixture use-cases (doc 08 §3): schedule/venue/officials PATCH, lineups PUT,
// ledger reads (events since_seq), live state (summary + last_seq for ETag).
import type postgres from "postgres";
import { withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { PatchFixture, PutLineup } from "@/server/api-v1/schemas";
import { FIXTURE_COLS, type FixtureRow } from "./stages";

export async function getFixture(auth: AuthCtx, id: string): Promise<FixtureRow> {
  return withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<FixtureRow[]>`
      select ${tx(FIXTURE_COLS)} from fixtures where id = ${id}`;
    if (!row) throw new HttpError(404, "fixture not found");
    return row;
  });
}

/** All fixtures of a division in play order — the organiser console read. */
export async function listDivisionFixtures(auth: AuthCtx, divisionId: string): Promise<FixtureRow[]> {
  return withTenant(auth.orgId, async (tx) => {
    const [division] = await tx`select 1 from divisions where id = ${divisionId}`;
    if (!division) throw new HttpError(404, "division not found");
    return tx<FixtureRow[]>`
      select ${tx(FIXTURE_COLS)} from fixtures
      where division_id = ${divisionId}
      order by stage_id, round_no, seq_in_round`;
  });
}

export async function patchFixture(auth: AuthCtx, id: string, patch: PatchFixture): Promise<FixtureRow> {
  return withTenant(auth.orgId, async (tx) => {
    const cols = Object.keys(patch);
    const values = {
      ...patch,
      ...(patch.officials ? { officials: tx.json(patch.officials as never) } : {}),
    };
    const [row] = await tx<FixtureRow[]>`
      update fixtures set ${tx(values as never, ...(cols as never[]))}
      where id = ${id} returning ${tx(FIXTURE_COLS)}`;
    if (!row) throw new HttpError(404, "fixture not found");
    return row;
  });
}

export interface LineupOut {
  fixture_id: string;
  entrant_id: string;
  slots: unknown[];
}

/** Replace an entrant's lineup for a fixture (idempotent PUT, doc 08 §3). */
export async function putLineup(
  auth: AuthCtx,
  fixtureId: string,
  entrantId: string,
  input: PutLineup,
): Promise<LineupOut> {
  return withTenant(auth.orgId, async (tx) => {
    const [fixture] = await tx<{ home_entrant_id: string | null; away_entrant_id: string | null; status: string }[]>`
      select home_entrant_id, away_entrant_id, status from fixtures where id = ${fixtureId}`;
    if (!fixture) throw new HttpError(404, "fixture not found");
    if (fixture.home_entrant_id !== entrantId && fixture.away_entrant_id !== entrantId) {
      throw new HttpError(422, "entrant is not a side of this fixture");
    }
    if (fixture.status !== "scheduled") {
      throw new HttpError(422, `lineup is locked once a fixture is ${fixture.status}`);
    }
    const ids = [...new Set(input.slots.map((s) => s.person_id))];
    if (ids.length !== input.slots.length) {
      throw new HttpError(422, "duplicate person in lineup");
    }
    if (ids.length > 0) {
      const members = await tx<{ person_id: string }[]>`
        select person_id from entrant_members
        where entrant_id = ${entrantId} and person_id in ${tx(ids)}`;
      if (members.length !== ids.length) {
        throw new HttpError(422, "lineup contains a person who is not a member of the entrant");
      }
    }
    await tx`delete from lineups where fixture_id = ${fixtureId} and entrant_id = ${entrantId}`;
    for (const [i, s] of input.slots.entries()) {
      await tx`
        insert into lineups (fixture_id, entrant_id, person_id, slot, position_key, order_no, roles)
        values (${fixtureId}, ${entrantId}, ${s.person_id}, ${s.slot},
                ${s.position_key ?? null}, ${s.order_no ?? i + 1}, ${tx.json(s.roles as never)})`;
    }
    return readLineup(tx, fixtureId, entrantId);
  });
}

/** Read an entrant's lineup for a fixture. */
export async function getLineup(auth: AuthCtx, fixtureId: string, entrantId: string): Promise<LineupOut> {
  return withTenant(auth.orgId, async (tx) => {
    const [fixture] = await tx`select 1 from fixtures where id = ${fixtureId}`;
    if (!fixture) throw new HttpError(404, "fixture not found");
    return readLineup(tx, fixtureId, entrantId);
  });
}

async function readLineup(
  tx: postgres.TransactionSql,
  fixtureId: string,
  entrantId: string,
): Promise<LineupOut> {
  const slots = await tx<Record<string, unknown>[]>`
    select l.person_id, p.full_name, l.slot, l.position_key, l.order_no, l.roles
    from lineups l join persons p on p.id = l.person_id
    where l.fixture_id = ${fixtureId} and l.entrant_id = ${entrantId}
    order by l.order_no nulls last, p.full_name`;
  return { fixture_id: fixtureId, entrant_id: entrantId, slots };
}

export interface EventOut {
  id: string;
  seq: number;
  type: string;
  payload: unknown;
  recorded_at: string;
  recorded_by: string | null;
  voids_event_id: string | null;
}

/** Ledger read: events after `sinceSeq` (the 409-recovery resync, doc 08 §4). */
export async function listEvents(auth: AuthCtx, fixtureId: string, sinceSeq: number): Promise<EventOut[]> {
  return withTenant(auth.orgId, async (tx) => {
    const [fixture] = await tx`select 1 from fixtures where id = ${fixtureId}`;
    if (!fixture) throw new HttpError(404, "fixture not found");
    return tx<EventOut[]>`
      select id, seq, type, payload, recorded_at, recorded_by, voids_event_id
      from score_events
      where fixture_id = ${fixtureId} and seq > ${sinceSeq}
      order by seq`;
  });
}

export interface FixtureStateOut {
  fixture_id: string;
  status: string;
  last_seq: number;
  summary: unknown;
  state: unknown;
  outcome: unknown;
}

/** Live state: fold cache summary + status + outcome (ETag on last_seq). */
export async function getFixtureState(auth: AuthCtx, fixtureId: string): Promise<FixtureStateOut> {
  return withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<
      { status: string; outcome: unknown; last_seq: number | null; state: unknown; summary: unknown }[]
    >`
      select f.status, f.outcome, m.last_seq, m.state, m.summary
      from fixtures f left join match_states m on m.fixture_id = f.id
      where f.id = ${fixtureId}`;
    if (!row) throw new HttpError(404, "fixture not found");
    return {
      fixture_id: fixtureId,
      status: row.status,
      last_seq: row.last_seq ?? 0,
      summary: row.summary ?? null,
      state: row.state ?? null,
      outcome: row.outcome,
    };
  });
}
