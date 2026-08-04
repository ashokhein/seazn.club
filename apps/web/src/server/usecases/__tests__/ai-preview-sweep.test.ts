import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { seedOrg } from "./_seed";
import { sweepExpiredPreviews } from "../ai-preview-sweep";

// #403: ai_parse_previews.instruction is the organiser's raw sentence, kept
// verbatim. V345 gives it a 30-minute life and an index commented "Sweep
// support" — and nothing swept it, so every previewed instruction survived
// until the org itself was deleted. These tests pin the retention policy the
// privacy page now states.
// The unit CI job runs without a database; these need one. Same guard the
// sibling preview suites use (schedule-ai-preview.test.ts:83).
const HAS_DB = !!process.env.DATABASE_URL;

describe.skipIf(!HAS_DB)("#403 — ai_parse_previews retention sweep", () => {
  let orgId: string;

  beforeEach(async () => {
    const { auth } = await seedOrg("pro");
    orgId = auth.orgId;
    await sql`delete from ai_parse_previews where org_id = ${orgId}`;
  });

  afterAll(async () => {
    if (orgId) await sql`delete from ai_parse_previews where org_id = ${orgId}`;
  });

  /** `age` is applied to created_at, expires_at and (when consumed) consumed_at,
   *  so a row reads as one taken that long ago. */
  async function insertPreview(o: {
    ageMinutes: number;
    ttlMinutes: number;
    consumed: boolean;
  }): Promise<string> {
    const [row] = await sql<{ id: string }[]>`
      insert into ai_parse_previews
        (org_id, scope, scope_id, instruction_hash, instruction, resolved,
         created_at, expires_at, consumed_at)
      values (
        ${orgId}, 'division', ${crypto.randomUUID()}, ${"h" + Math.random()},
        ${"keep the two Alex Morgans apart"}, ${sql.json({ hard: [], soft: [], unparsed: [] })},
        now() - (${o.ageMinutes} || ' minutes')::interval,
        now() - (${o.ageMinutes} || ' minutes')::interval + (${o.ttlMinutes} || ' minutes')::interval,
        ${o.consumed ? sql`now() - (${o.ageMinutes} || ' minutes')::interval` : null}
      )
      returning id`;
    return row!.id;
  }

  const alive = async (id: string): Promise<boolean> =>
    (await sql`select 1 from ai_parse_previews where id = ${id}`).length === 1;

  it("deletes an unconsumed preview once it has expired", async () => {
    // The organiser looked at the compile and walked away. The run gate requires
    // `consumed_at is null AND expires_at > now()`, so this row can never be
    // used again — it is only the sentence, still stored.
    const id = await insertPreview({ ageMinutes: 60, ttlMinutes: 30, consumed: false });
    const out = await sweepExpiredPreviews();
    expect(out.expired).toBeGreaterThanOrEqual(1);
    expect(await alive(id)).toBe(false);
  });

  it("keeps an unconsumed preview that is still live", async () => {
    // Deleting this one would break the feature: the run gate looks it up.
    const id = await insertPreview({ ageMinutes: 1, ttlMinutes: 30, consumed: false });
    await sweepExpiredPreviews();
    expect(await alive(id)).toBe(true);
  });

  it("keeps a consumed preview inside the 30-day dispute window", async () => {
    // V345 keeps `raw` beside `resolved` so a disputed compile can be re-derived.
    const id = await insertPreview({ ageMinutes: 60, ttlMinutes: 30, consumed: true });
    await sweepExpiredPreviews();
    expect(await alive(id)).toBe(true);
  });

  it("deletes a consumed preview once the dispute window has passed", async () => {
    const id = await insertPreview({ ageMinutes: 31 * 24 * 60, ttlMinutes: 30, consumed: true });
    const out = await sweepExpiredPreviews();
    expect(out.spent).toBeGreaterThanOrEqual(1);
    expect(await alive(id)).toBe(false);
  });

  it("counts the two classes separately", async () => {
    const expiredId = await insertPreview({ ageMinutes: 90, ttlMinutes: 30, consumed: false });
    const spentId = await insertPreview({ ageMinutes: 40 * 24 * 60, ttlMinutes: 30, consumed: true });
    const liveId = await insertPreview({ ageMinutes: 1, ttlMinutes: 30, consumed: false });
    const out = await sweepExpiredPreviews();
    expect(out.expired).toBeGreaterThanOrEqual(1);
    expect(out.spent).toBeGreaterThanOrEqual(1);
    expect(await alive(expiredId)).toBe(false);
    expect(await alive(spentId)).toBe(false);
    expect(await alive(liveId)).toBe(true);
  });

  it("is idempotent — a second sweep finds nothing left to do for these rows", async () => {
    await insertPreview({ ageMinutes: 90, ttlMinutes: 30, consumed: false });
    await sweepExpiredPreviews();
    const before = await sql<{ n: string }[]>`
      select count(*) as n from ai_parse_previews where org_id = ${orgId}`;
    await sweepExpiredPreviews();
    const after = await sql<{ n: string }[]>`
      select count(*) as n from ai_parse_previews where org_id = ${orgId}`;
    expect(after[0]!.n).toBe(before[0]!.n);
  });
});
