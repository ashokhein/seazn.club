// segmentsForGroup reads the payer timeline from the transfer ledger — group
// creation opens the first segment, each ACCEPTED transfer closes one and opens
// the next. It feeds tenure-window invoice scoping (each payer sees only their
// own tenure's invoices). Real Postgres required.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { segmentsForGroup } from "../billing-manage";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);
// The first tenure opens at epoch 0 (the original payer owns everything before
// the first handover); T1/T2 are the handover instants.
const ORIGIN = 0;
const T1 = "2026-02-01T00:00:00.000Z";
const T2 = "2026-03-01T00:00:00.000Z";

async function makeUser(): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`seg-${uniq()}@test.local`}, 'Seg', true) returning id`;
  return id;
}

async function makeGroup(ownerId: string): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into subscriptions (owner_user_id, plan_key, status, quantity_paid)
    values (${ownerId}, 'pro', 'active', 1) returning id`;
  return id;
}

async function makeTransfer(
  subId: string,
  from: string,
  to: string,
  status: string,
  resolvedAt: string | null,
): Promise<void> {
  await sql`
    insert into billing_group_transfers
      (subscription_id, from_user_id, to_user_id, status, expires_at, resolved_at)
    values (${subId}, ${from}, ${to}, ${status}, now() + interval '7 days', ${resolvedAt})`;
}

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("segmentsForGroup", () => {
  it("a group that never changed hands is one open segment for the current payer", async () => {
    const u1 = await makeUser();
    const sub = await makeGroup(u1);
    const segs = await segmentsForGroup(sub);
    expect(segs).toEqual([{ payerUserId: u1, startMs: ORIGIN, endMs: null }]);
  });

  it("one accepted transfer splits the timeline at resolved_at", async () => {
    const u1 = await makeUser();
    const u2 = await makeUser();
    const sub = await makeGroup(u1);
    await makeTransfer(sub, u1, u2, "accepted", T1);
    await sql`update subscriptions set owner_user_id = ${u2} where id = ${sub}`;

    const segs = await segmentsForGroup(sub);
    expect(segs).toEqual([
      { payerUserId: u1, startMs: ORIGIN, endMs: Date.parse(T1) },
      { payerUserId: u2, startMs: Date.parse(T1), endMs: null },
    ]);
  });

  it("a round-trip yields three segments, current payer last", async () => {
    const u1 = await makeUser();
    const u2 = await makeUser();
    const sub = await makeGroup(u1);
    await makeTransfer(sub, u1, u2, "accepted", T1);
    await makeTransfer(sub, u2, u1, "accepted", T2);
    // u1 owns it again.

    const segs = await segmentsForGroup(sub);
    expect(segs).toEqual([
      { payerUserId: u1, startMs: ORIGIN, endMs: Date.parse(T1) },
      { payerUserId: u2, startMs: Date.parse(T1), endMs: Date.parse(T2) },
      { payerUserId: u1, startMs: Date.parse(T2), endMs: null },
    ]);
  });

  it("ignores offers that never completed — pending, revoked, expired", async () => {
    const u1 = await makeUser();
    const u2 = await makeUser();
    const sub = await makeGroup(u1);
    // A pending offer (no resolved_at), a revoked one, an expired one: none of
    // these handed the group over, so the timeline stays a single tenure.
    await makeTransfer(sub, u1, u2, "pending", null);
    await makeTransfer(sub, u1, u2, "revoked", T1);
    await makeTransfer(sub, u1, u2, "expired", T1);

    const segs = await segmentsForGroup(sub);
    expect(segs).toEqual([{ payerUserId: u1, startMs: ORIGIN, endMs: null }]);
  });
});
