// Tracked sponsor redirect (v10 PROMPT-56): public sponsor logos link here so
// organisers can show sponsors real click numbers. The count bump is tail
// work — it must never delay or break the redirect itself.
import { sql } from "@/lib/db";
import { deferred } from "@/lib/deferred";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Ctx = { params: Promise<{ sponsorId: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const { sponsorId } = await params;
  if (!UUID_RE.test(sponsorId)) return new Response("Not found", { status: 404 });
  const [row] = await sql<{ url: string | null }[]>`
    select url from sponsors where id = ${sponsorId} and status = 'active'`;
  if (!row?.url) return new Response("Not found", { status: 404 });

  deferred(
    () => sql`update sponsors set click_count = click_count + 1 where id = ${sponsorId}`,
  );
  return Response.redirect(row.url, 302);
}
