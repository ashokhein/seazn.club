// GDPR clickwrap stamping (spec 2026-07-14). Real Postgres required; skipped
// without DATABASE_URL, like the other DB-backed suites.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { LEGAL_VERSION, stampTermsAcceptance } from "@/lib/legal";

const HAS_DB = !!process.env.DATABASE_URL;

describe.skipIf(!HAS_DB)("stampTermsAcceptance", () => {
  afterAll(async () => {
    await sql.end();
  });

  it("stamps first acceptance and never moves it", async () => {
    const email = `legal-${randomUUID()}@example.com`;
    const [u] = await sql<{ id: string }[]>`
      insert into users (email, display_name) values (${email}, 'Legal Test') returning id`;

    await stampTermsAcceptance(u.id);
    const [first] = await sql<{ terms_accepted_at: Date; terms_version: string }[]>`
      select terms_accepted_at, terms_version from users where id = ${u.id}`;
    expect(first.terms_accepted_at).toBeInstanceOf(Date);
    expect(first.terms_version).toBe(LEGAL_VERSION);

    await stampTermsAcceptance(u.id);
    const [second] = await sql<{ terms_accepted_at: Date }[]>`
      select terms_accepted_at from users where id = ${u.id}`;
    // Compare via getTime() — Date identity assertions are a vitest trap.
    expect(second.terms_accepted_at.getTime()).toBe(first.terms_accepted_at.getTime());
  });
});
