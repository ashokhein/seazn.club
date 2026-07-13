// Staff-console Stripe event replay (spec 2026-07-13): eventStatus drives the
// processed/received/missing chips; runEvent stamps processed_at only after
// the handler ran; replayEvent refuses to double-run what the ledger already
// saw through. DB parts skipped without DATABASE_URL.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";
import { sql } from "@/lib/db";
import {
  eventStatus,
  ledgerByIds,
  replayEvent,
  runEvent,
  stuckLedgerEvents,
} from "../billing-events";

const HAS_DB = !!process.env.DATABASE_URL;

/** Unhandled type on purpose: the dispatch is a no-op, so these tests pin the
 *  ledger mechanics without touching subscriptions/registrations state. */
function fakeEvent(over: Partial<{ id: string; type: string }> = {}): Stripe.Event {
  return {
    id: over.id ?? `evt_test_${randomUUID().replace(/-/g, "")}`,
    type: over.type ?? "product.created",
    created: Math.floor(Date.now() / 1000),
    data: { object: { metadata: {} } },
  } as unknown as Stripe.Event;
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe("eventStatus (pure)", () => {
  it("no ledger row → missing (webhook never received it)", () => {
    expect(eventStatus(undefined)).toBe("missing");
  });
  it("row without processed_at → received (handler didn't finish)", () => {
    expect(eventStatus({ processed_at: null })).toBe("received");
  });
  it("processed_at set → processed", () => {
    expect(eventStatus({ processed_at: "2026-07-13T00:00:00Z" })).toBe("processed");
    expect(eventStatus({ processed_at: new Date() })).toBe("processed");
  });
});

describe.skipIf(!HAS_DB)("event ledger mechanics", () => {
  it("runEvent records the row and stamps processed_at", async () => {
    const event = fakeEvent();
    await runEvent(event);
    const rows = await ledgerByIds([event.id]);
    expect(eventStatus(rows.get(event.id))).toBe("processed");
  });

  it("replayEvent skips an already-processed event, heals a stuck one", async () => {
    const done = fakeEvent();
    await runEvent(done);
    expect(await replayEvent(done)).toBe("already_processed");

    // A stuck row: received (inserted) but the handler never finished.
    const stuck = fakeEvent();
    await sql`
      insert into billing_events (id, type, org_id, payload)
      values (${stuck.id}, ${stuck.type}, null, '{}')`;
    const before = await ledgerByIds([stuck.id]);
    expect(eventStatus(before.get(stuck.id))).toBe("received");
    expect((await stuckLedgerEvents([])).some((r) => r.id === stuck.id)).toBe(true);

    expect(await replayEvent(stuck)).toBe("processed");
    const after = await ledgerByIds([stuck.id]);
    expect(eventStatus(after.get(stuck.id))).toBe("processed");
    expect((await stuckLedgerEvents([])).some((r) => r.id === stuck.id)).toBe(false);
  });

  it("stuckLedgerEvents honours the exclusion list (live-window dedupe)", async () => {
    const stuck = fakeEvent();
    await sql`
      insert into billing_events (id, type, org_id, payload)
      values (${stuck.id}, ${stuck.type}, null, '{}')`;
    expect((await stuckLedgerEvents([stuck.id])).some((r) => r.id === stuck.id)).toBe(false);
    // cleanup so other assertions on the shared DB stay stable
    await sql`delete from billing_events where id = ${stuck.id}`;
  });
});
