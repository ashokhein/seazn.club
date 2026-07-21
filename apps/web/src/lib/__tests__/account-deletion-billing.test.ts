// Account deletion is the irreversible half of DELETE /api/users/me, and it
// runs AFTER the billing groups the leaver pays for have been handed on or shut
// down. When there is no heir the group is cancelled outright — and if Stripe
// refuses that cancel, going on to anonymise and soft-delete the user produces
// the exact state the loop exists to prevent: a live subscription whose
// `owner_user_id` points at a deleted user, so every billing route 403s, nobody
// can ever cancel it, and the card keeps being charged. Nothing retries either —
// reconcileGroupQuantities selects on `quantity_paid <> live org count`, which a
// group with the right quantity does not satisfy.
//
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const stripeMock = vi.hoisted(() => ({
  cancel: vi.fn(async () => ({})),
}));
vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({ subscriptions: { cancel: stripeMock.cancel } }),
}));

// The session half of auth only: requireUser stands in for the cookie, and the
// three cache/session teardown calls have nowhere to write in a unit test.
// Everything else — the block query, the heir search, cancelBillingGroup, the
// anonymisation transaction — runs for real against Postgres.
const authState = vi.hoisted(() => ({
  user: null as { id: string; email: string; locale: string | null } | null,
}));
vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  requireUser: vi.fn(async () => authState.user),
  destroySession: vi.fn(async () => {}),
  invalidateUser: vi.fn(async () => {}),
  invalidateUserOrgs: vi.fn(async () => {}),
}));
vi.mock("@/lib/email", () => ({ sendAccountDeletionEmail: vi.fn(async () => {}) }));

import { sql } from "@/lib/db";
import { DELETE } from "@/app/api/users/me/route";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

/** A payer who is the sole member and owner of one org, in a group with a live
 *  Stripe subscription and nobody who could inherit it. */
async function seedSoleOwner(): Promise<{ userId: string; subId: string; email: string }> {
  const s = uniq();
  const email = `del-${s}@test.local`;
  const [{ id: userId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${email}, 'Leaver', true) returning id`;
  const [{ id: subId }] = await sql<{ id: string }[]>`
    insert into subscriptions
      (owner_user_id, plan_key, status, stripe_subscription_id, stripe_customer_id,
       status_changed_at)
    values (${userId}, 'pro', 'active', ${"sub_del_" + s}, ${"cus_del_" + s}, now())
    returning id`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by, subscription_id)
    values (${"Del " + s}, ${"del-" + s}, ${userId}, ${subId}) returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${userId}, 'owner')`;
  authState.user = { id: userId, email, locale: null };
  return { userId, subId, email };
}

const readUser = async (id: string) =>
  (
    await sql<{ email: string; deleted_at: Date | null; display_name: string }[]>`
      select email, deleted_at, display_name from users where id = ${id}`
  )[0];

const readSub = async (id: string) =>
  (
    await sql<{ status: string; plan_key: string; owner_user_id: string }[]>`
      select status, plan_key, owner_user_id from subscriptions where id = ${id}`
  )[0];

const del = () =>
  DELETE(
    new Request("http://test.local/api/users/me", {
      method: "DELETE",
      body: JSON.stringify({ confirm: "DELETE" }),
    }),
  );

beforeEach(() => {
  vi.clearAllMocks();
  stripeMock.cancel.mockResolvedValue({});
});

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("deleting the account of a group's only payer", () => {
  it("cancels the group and then deletes, when Stripe accepts the cancel", async () => {
    const { userId, subId, email } = await seedSoleOwner();

    const res = await del();
    expect(res.status).toBe(200);

    expect(stripeMock.cancel).toHaveBeenCalledTimes(1);
    const sub = await readSub(subId);
    expect(sub.status).toBe("canceled");
    expect(sub.plan_key).toBe("community");
    const user = await readUser(userId);
    expect(user.deleted_at).not.toBeNull();
    expect(user.email).not.toBe(email);
  });

  it("REFUSES TO DELETE when Stripe refuses the cancel, leaving the account intact", async () => {
    // The alternative is losing the argument in the worst direction: the
    // subscription stays live and keeps charging, and the only person who could
    // ever cancel it has just been anonymised out of existence. Deletion is the
    // irreversible half, so it is the half that yields — the user still has an
    // account, still owns the group, and can try again.
    const { userId, subId, email } = await seedSoleOwner();
    stripeMock.cancel.mockRejectedValueOnce(new Error("stripe is down"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    let res;
    try {
      res = await del();
    } finally {
      err.mockRestore();
    }

    expect(res.status).toBeGreaterThanOrEqual(500);
    // Still live, still billable, still visible to whoever needs to fix it.
    const sub = await readSub(subId);
    expect(sub.status).toBe("active");
    expect(sub.plan_key).toBe("pro");
    // And above all: the payer still exists and still owns it.
    expect(sub.owner_user_id).toBe(userId);
    const user = await readUser(userId);
    expect(user.deleted_at).toBeNull();
    expect(user.email).toBe(email);
    expect(user.display_name).not.toBe("Deleted User");
    // Their org memberships are what the heir search reads — destroying them
    // would make the retry find no heir and no org either.
    const [{ n }] = await sql<{ n: string }[]>`
      select count(*)::text as n from org_members where user_id = ${userId}`;
    expect(Number(n)).toBe(1);
  });

  it("hands the group to the heir instead, and never calls Stripe", async () => {
    // The other branch of the same loop: with somebody left who can manage the
    // group, nothing is cancelled and the deletion goes through.
    const { userId, subId } = await seedSoleOwner();
    const [{ id: heirId }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified)
      values (${`heir-${uniq()}@test.local`}, 'Heir', true) returning id`;
    const [{ id: orgId }] = await sql<{ id: string }[]>`
      select id from organizations where subscription_id = ${subId}`;
    await sql`insert into org_members (org_id, user_id, role)
              values (${orgId}, ${heirId}, 'owner')`;

    const res = await del();
    expect(res.status).toBe(200);
    expect(stripeMock.cancel).not.toHaveBeenCalled();
    const sub = await readSub(subId);
    expect(sub.owner_user_id).toBe(heirId);
    expect(sub.status).toBe("active");
    expect((await readUser(userId)).deleted_at).not.toBeNull();
  });
});
