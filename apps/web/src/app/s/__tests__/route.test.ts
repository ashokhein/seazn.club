// Tracked sponsor redirect /s/[sponsorId] (v10 PROMPT-56): 302 to the
// sponsor url with a click_count bump that never blocks the redirect
// (deferred() falls back to inline fire-and-forget outside a request scope,
// so the count is poll-asserted). Real Postgres required.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { GET } from "../[sponsorId]/route";

const HAS_DB = !!process.env.DATABASE_URL;

const ctx = (sponsorId: string) => ({ params: Promise.resolve({ sponsorId }) });

async function seedSponsor(url: string | null, status = "active"): Promise<string> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Clk " + suffix}, ${"clk-" + suffix})
    returning id`;
  const [{ id }] = await sql<{ id: string }[]>`
    insert into sponsors (org_id, name, url, status)
    values (${orgId}, 'Clicky', ${url}, ${status})
    returning id`;
  return id;
}

describe.skipIf(!HAS_DB)("GET /s/[sponsorId]", () => {
  it("302s to the sponsor url and increments click_count once", async () => {
    const id = await seedSponsor("https://clicky.example/offer");
    const res = await GET(new Request("http://x/s/" + id), ctx(id));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://clicky.example/offer");

    await vi.waitFor(async () => {
      const [row] = await sql<{ click_count: number }[]>`
        select click_count from sponsors where id = ${id}`;
      expect(row.click_count).toBe(1);
    });
  });

  it("404s for unknown ids, url-less and inactive sponsors", async () => {
    expect((await GET(new Request("http://x"), ctx("not-a-uuid"))).status).toBe(404);
    expect((await GET(new Request("http://x"), ctx(randomUUID()))).status).toBe(404);

    const noUrl = await seedSponsor(null);
    expect((await GET(new Request("http://x"), ctx(noUrl))).status).toBe(404);

    const inactive = await seedSponsor("https://gone.example", "inactive");
    expect((await GET(new Request("http://x"), ctx(inactive))).status).toBe(404);
  });
});

afterAll(async () => {
  if (!HAS_DB) return;
  await sql.end();
});
