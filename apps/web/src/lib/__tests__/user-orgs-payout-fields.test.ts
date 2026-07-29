import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { getUserOrgs } from "@/lib/auth";

/**
 * `getUserOrgs` must not carry payout free-text (#341).
 *
 * Its result is not an ordinary query result. It is (a) written to Redis as
 * plaintext JSON under `orgs:<userId>` for 120s and (b) returned verbatim as the
 * body of `GET /api/orgs`, a nav endpoint any member may call. So every column
 * the select names is copied into a second vendor and shipped to every member of
 * every org they belong to.
 *
 * `payment_instructions` is free text an owner writes to tell offline entrants
 * how to pay them — bank details, IBANs, UPI handles, `z.string().max(5000)`.
 * Nothing downstream of this list ever read it: the settings page and the
 * registration use-case each run their own scoped select.
 *
 * The assertion is on the RETURNED array because that is the identical object
 * passed to `cacheSet` — there is no second serialisation step that could
 * differ. Asserting the SQL text instead would pass on a query that selected
 * `o.*`.
 */
describe.skipIf(!process.env.DATABASE_URL)("getUserOrgs carries no payout fields (#341)", () => {
  const seed = async () => {
    const s = randomUUID().slice(0, 8);
    const [user] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified)
      values (${`orgs-payout-${s}@test.local`}, 'Payout Probe', true) returning id`;
    const [org] = await sql<{ id: string }[]>`
      insert into organizations (name, slug, created_by, payment_instructions,
                                 default_payment_method)
      values (${`Payout Probe ${s}`}, ${`payout-probe-${s}`}, ${user!.id},
              'IBAN GB29 NWBK 6016 1331 9268 19', 'offline')
      returning id`;
    await sql`
      insert into org_members (org_id, user_id, role)
      values (${org!.id}, ${user!.id}, 'owner')`;
    return { userId: user!.id, orgId: org!.id };
  };

  it("returns the membership without payment_instructions or default_payment_method", async () => {
    const { userId, orgId } = await seed();
    const orgs = await getUserOrgs(userId);

    // Canary: the probe row must actually be in the result, or every absence
    // assertion below is vacuous.
    const row = orgs.find((o) => o.id === orgId);
    expect(row, "seeded org missing from getUserOrgs result").toBeDefined();

    // `in` rather than a truthiness check: a null value would still be a leaked
    // column on an org that simply has not set its instructions yet.
    expect("payment_instructions" in row!).toBe(false);
    expect("default_payment_method" in row!).toBe(false);
  });

  it("still carries the identity columns the nav needs", async () => {
    // The other half of the guard: a select trimmed too far breaks the org
    // switcher and page-auth rather than leaking, and would otherwise pass the
    // test above.
    const { userId, orgId } = await seed();
    const row = (await getUserOrgs(userId)).find((o) => o.id === orgId)!;
    for (const k of ["id", "name", "slug", "created_by", "created_at", "logo_url",
                     "logo_storage_path", "branding", "timezone", "role"]) {
      expect(k in row, `identity column ${k} missing from getUserOrgs`).toBe(true);
    }
  });

  it("the payout columns are still readable where they belong", async () => {
    // Proves the fix moved the exposure rather than deleting the data — the
    // org-settings lane reads them with its own scoped select.
    const { orgId } = await seed();
    const [row] = await sql<{ payment_instructions: string | null }[]>`
      select payment_instructions from organizations where id = ${orgId}`;
    expect(row!.payment_instructions).toContain("IBAN");
  });
});
