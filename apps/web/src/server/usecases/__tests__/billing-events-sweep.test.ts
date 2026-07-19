// Stuck-webhook auto-replay sweep (payments-hardening Task 11, P1-7): events
// that land in billing_events but never get processed (deploy crash / transient
// DB error mid-handler) sit `received` forever. sweepStuckEvents re-pulls each
// stuck row FRESH from Stripe (the trust anchor — never the stored payload) and
// replays it; handlers are replay-idempotent by contract, so this is safe. A
// row is retried up to 3 times, then parked (attempts capped at 4 so the sweep
// never re-selects it) and staff are alerted once.
//
// Real Postgres required; skipped without DATABASE_URL. Seeds are run-unique
// (randomUUID) and beforeEach clears the sweep's working set (old unprocessed
// rows) so the returned counts are exact; the 10-minute window means any
// concurrent FRESH row (received now) is left untouched.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

// Observe the staff alert without touching the rest of the email module (send()
// is a no-op without RESEND_API_KEY either way).
const emailMock = vi.hoisted(() => ({ alert: vi.fn().mockResolvedValue(true) }));
vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email")>()),
  sendStuckEventsAlertEmail: emailMock.alert,
}));

// The sweep re-pulls each event via getStripe().events.retrieve (the trust
// anchor). Stub that seam — @/lib/stripe exports only getStripe.
const stripeMock = vi.hoisted(() => {
  const retrieve = vi.fn();
  return { retrieve, stripe: { events: { retrieve } } };
});
vi.mock("@/lib/stripe", () => ({ getStripe: () => stripeMock.stripe }));

import { sql } from "@/lib/db";
import { sweepStuckEvents } from "../billing-events";

const HAS_DB = !!process.env.DATABASE_URL;
const evtId = (tag: string) => `evt_sweep_${tag}_${randomUUID().slice(0, 8)}`;

/** A stuck ledger row: received `ageMin` ago, never processed, `attempts` tries. */
async function seedStuck(id: string, attempts = 0, ageMin = 20): Promise<void> {
  await sql`
    insert into billing_events (id, type, org_id, payload, received_at, replay_attempts)
    values (${id}, 'product.created', null, '{}',
            now() - (${ageMin} * interval '1 minute'), ${attempts})`;
}

/** The no-op event the retrieve stub returns: an unhandled type dispatches to a
 *  silent no-op, so runEvent just stamps processed_at. */
const fakeEvent = (id: string) => ({
  id,
  type: "product.created",
  created: 0,
  data: { object: { metadata: {} } },
});

beforeEach(async () => {
  emailMock.alert.mockClear();
  stripeMock.retrieve.mockReset();
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_sweep");
  if (!HAS_DB) return;
  await sql`delete from billing_events
    where processed_at is null and received_at < now() - interval '10 minutes'`;
});
afterEach(() => vi.unstubAllEnvs());

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("sweepStuckEvents (P1-7)", () => {
  it("replays a stuck received row: stamps processed_at, counts it replayed", async () => {
    const id = evtId("ok");
    await seedStuck(id, 0);
    stripeMock.retrieve.mockImplementation((eid: string) => Promise.resolve(fakeEvent(eid)));

    const res = await sweepStuckEvents();

    expect(res).toEqual({ replayed: 1, failed: 0, alerted: 0 });
    expect(stripeMock.retrieve).toHaveBeenCalledWith(id);
    const [row] = await sql<{ processed_at: Date | null; replay_attempts: number }[]>`
      select processed_at, replay_attempts from billing_events where id = ${id}`;
    expect(row.processed_at).not.toBeNull();
    expect(row.replay_attempts).toBe(0); // a clean replay never bumps the counter
  });

  it("a retrieve failure increments replay_attempts and leaves the row stuck", async () => {
    const id = evtId("fail");
    await seedStuck(id, 0);
    stripeMock.retrieve.mockRejectedValue(new Error("stripe unavailable"));

    const res = await sweepStuckEvents();

    expect(res).toEqual({ replayed: 0, failed: 1, alerted: 0 });
    const [row] = await sql<{ processed_at: Date | null; replay_attempts: number }[]>`
      select processed_at, replay_attempts from billing_events where id = ${id}`;
    expect(row.replay_attempts).toBe(1);
    expect(row.processed_at).toBeNull();
  });

  it("caps at 3 attempts: parks the row, alerts staff once, never re-alerts", async () => {
    vi.stubEnv("STAFF_ALERT_EMAIL", "ops@seazn.club");
    const id = evtId("cap");
    await seedStuck(id, 3);
    stripeMock.retrieve.mockRejectedValue(new Error("must not be called on a capped row"));

    const res = await sweepStuckEvents();

    expect(res).toEqual({ replayed: 0, failed: 0, alerted: 1 });
    expect(stripeMock.retrieve).not.toHaveBeenCalled(); // capped row is never re-pulled
    expect(emailMock.alert).toHaveBeenCalledTimes(1);
    expect(emailMock.alert.mock.calls[0]![0]).toMatchObject({ to: "ops@seazn.club", eventId: id });
    const [row] = await sql<{ replay_attempts: number }[]>`
      select replay_attempts from billing_events where id = ${id}`;
    expect(row.replay_attempts).toBe(4); // 4 → filtered out of every future sweep

    // Second pass: the parked row is out of the working set, so no repeat alert.
    emailMock.alert.mockClear();
    const res2 = await sweepStuckEvents();
    expect(res2.alerted).toBe(0);
    expect(emailMock.alert).not.toHaveBeenCalled();
  });

  it("honours the limit param (only that many rows per pass)", async () => {
    const ids = [evtId("lim"), evtId("lim"), evtId("lim")];
    for (const id of ids) await seedStuck(id, 0);
    stripeMock.retrieve.mockImplementation((eid: string) => Promise.resolve(fakeEvent(eid)));

    const res = await sweepStuckEvents(2);

    expect(res.replayed).toBe(2);
    const done = await sql<{ id: string }[]>`
      select id from billing_events where id = any(${ids}) and processed_at is not null`;
    expect(done.length).toBe(2); // the third is left for the next pass
  });
});
