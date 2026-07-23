// getFormerPayerInvoices returns a FORMER payer's own invoices for a group they
// no longer pay for — scoped to their tenure(s), never the current payer's
// (whose name/address the invoice PDFs carry). Stripe's invoice list is mocked;
// the payer timeline is real, read from the seeded transfer ledger. Postgres
// required.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const invoicesList = vi.hoisted(() => vi.fn());
vi.mock("@/lib/stripe", () => ({ getStripe: () => ({ invoices: { list: invoicesList } }) }));

import { sql } from "@/lib/db";
import { getFormerPayerInvoices } from "../billing-manage";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);
const DAY = 86_400; // seconds
const C0 = 1_700_000_000;
const t1 = C0 + 100 * DAY; // handover u1 -> u2
const t2 = C0 + 200 * DAY; // handover u2 -> u1
const iso = (unixSec: number) => new Date(unixSec * 1000).toISOString();

// One invoice cut in each of three tenures.
const INVOICES = [
  { id: "in_t1", number: "A-1", created: C0 + 10 * DAY, total: 1000, currency: "gbp", status: "paid", hosted_invoice_url: "https://s/1", invoice_pdf: "https://s/1.pdf" },
  { id: "in_t2", number: "A-2", created: C0 + 150 * DAY, total: 2000, currency: "gbp", status: "paid", hosted_invoice_url: "https://s/2", invoice_pdf: "https://s/2.pdf" },
  { id: "in_t3", number: "A-3", created: C0 + 250 * DAY, total: 3000, currency: "gbp", status: "paid", hosted_invoice_url: "https://s/3", invoice_pdf: "https://s/3.pdf" },
];

async function makeUser(): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`fp-${uniq()}@test.local`}, 'FP', true) returning id`;
  return id;
}

async function makeGroup(ownerId: string, customerId: string | null): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into subscriptions (owner_user_id, plan_key, status, quantity_paid, stripe_customer_id)
    values (${ownerId}, 'pro', 'active', 1, ${customerId}) returning id`;
  return id;
}

/** An org billing through the group, so subRow(orgId) resolves it. */
async function makeOrg(subId: string, ownerId: string): Promise<string> {
  const s = uniq();
  const [{ id }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by, subscription_id)
    values (${`FP ${s}`}, ${`fp-${s}`}, ${ownerId}, ${subId}) returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${id}, ${ownerId}, 'owner')`;
  return id;
}

async function makeTransfer(subId: string, from: string, to: string, resolvedAt: string): Promise<void> {
  await sql`
    insert into billing_group_transfers
      (subscription_id, from_user_id, to_user_id, status, expires_at, resolved_at)
    values (${subId}, ${from}, ${to}, 'accepted', now() + interval '7 days', ${resolvedAt})`;
}

beforeEach(() => {
  invoicesList.mockReset();
  invoicesList.mockResolvedValue({ data: INVOICES });
});

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("getFormerPayerInvoices", () => {
  it("returns only the former payer's own tenure invoices", async () => {
    // u1 paid, then handed the group to u2. u1 is now a non-payer.
    const u1 = await makeUser();
    const u2 = await makeUser();
    const sub = await makeGroup(u2, "cus_" + uniq()); // current payer u2
    const org = await makeOrg(sub, u2);
    await makeTransfer(sub, u1, u2, iso(t1));

    const rows = await getFormerPayerInvoices(org, u1);
    expect(rows.map((r) => r.id)).toEqual(["in_t1"]); // before the handover only
  });

  it("returns nothing for the CURRENT payer — they use the full view", async () => {
    const u1 = await makeUser();
    const u2 = await makeUser();
    const sub = await makeGroup(u2, "cus_" + uniq());
    const org = await makeOrg(sub, u2);
    await makeTransfer(sub, u1, u2, iso(t1));

    expect(await getFormerPayerInvoices(org, u2)).toEqual([]);
    expect(invoicesList).not.toHaveBeenCalled(); // short-circuits before Stripe
  });

  it("returns nothing for someone who was never a payer here", async () => {
    const u1 = await makeUser();
    const u2 = await makeUser();
    const stranger = await makeUser();
    const sub = await makeGroup(u2, "cus_" + uniq());
    const org = await makeOrg(sub, u2);
    await makeTransfer(sub, u1, u2, iso(t1));

    expect(await getFormerPayerInvoices(org, stranger)).toEqual([]);
    expect(invoicesList).not.toHaveBeenCalled();
  });

  it("scopes a MIDDLE payer to their stretch only, on a round-trip", async () => {
    // u1 -> u2 -> u1. u2 is a former payer whose tenure is bounded on both sides.
    const u1 = await makeUser();
    const u2 = await makeUser();
    const sub = await makeGroup(u1, "cus_" + uniq()); // u1 owns it again now
    const org = await makeOrg(sub, u1);
    await makeTransfer(sub, u1, u2, iso(t1));
    await makeTransfer(sub, u2, u1, iso(t2));

    const rows = await getFormerPayerInvoices(org, u2);
    expect(rows.map((r) => r.id)).toEqual(["in_t2"]); // only between the handovers
  });

  it("returns nothing when the group has no Stripe customer", async () => {
    const u1 = await makeUser();
    const u2 = await makeUser();
    const sub = await makeGroup(u2, null);
    const org = await makeOrg(sub, u2);
    await makeTransfer(sub, u1, u2, iso(t1));

    expect(await getFormerPayerInvoices(org, u1)).toEqual([]);
    expect(invoicesList).not.toHaveBeenCalled();
  });
});
