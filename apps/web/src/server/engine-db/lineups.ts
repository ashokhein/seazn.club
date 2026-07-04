import "server-only";
import type postgres from "postgres";
import type { Lineup, LineupPair } from "@seazn/engine/core";

type Tx = postgres.TransactionSql;

interface LineupRow {
  entrant_id: string;
  person_id: string;
  slot: "starting" | "bench";
  position_key: string | null;
  order_no: number | null;
  roles: string[] | null;
}

// Build the [home, away] LineupPair a SportModule.init needs from the fixture's
// lineup rows. `orderNo` must be a positive int (spec 02 §3 LineupSlot); DB
// order_no is nullable, so fall back to append order. A fixture with an
// unassigned side (bye/TBD) cannot be scored — the caller rejects that earlier.
export async function loadLineupPair(
  tx: Tx,
  fixtureId: string,
  homeEntrantId: string,
  awayEntrantId: string,
): Promise<LineupPair> {
  const rows = await tx<LineupRow[]>`
    select entrant_id, person_id, slot, position_key, order_no, roles
    from lineups
    where fixture_id = ${fixtureId}
    order by order_no nulls last, person_id
  `;

  const build = (entrantId: string): Lineup => {
    const mine = rows.filter((r) => r.entrant_id === entrantId);
    return {
      entrantId,
      slots: mine.map((r, i) => ({
        personId: r.person_id,
        slot: r.slot,
        orderNo: r.order_no ?? i + 1,
        ...(r.position_key ? { positionKey: r.position_key } : {}),
        ...(r.roles && r.roles.length > 0 ? { roles: r.roles } : {}),
      })),
    };
  };

  return { home: build(homeEntrantId), away: build(awayEntrantId) };
}
