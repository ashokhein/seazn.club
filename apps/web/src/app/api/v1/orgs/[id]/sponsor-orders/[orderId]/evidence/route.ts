import { requireOrgAuth, assertUuid } from "@/server/api-v1/auth";
import { buildSponsorDisputeEvidence } from "@/server/usecases/sponsors";
import { baseUrl } from "@/lib/oauth";
import { AuthError, HttpError } from "@/lib/errors";

type Ctx = { params: Promise<{ id: string; orderId: string }> };

/** Organiser: download the dispute evidence pack for a sponsor order as a
 *  printable HTML document. Raw Response (an attachment), so this skips the
 *  v1 JSON envelope — auth is still the v1 org door. */
export async function GET(req: Request, { params }: Ctx) {
  const { id, orderId } = await params;
  try {
    assertUuid(id, "organization");
    assertUuid(orderId, "order");
    const auth = await requireOrgAuth(req, id, "write");
    const pack = await buildSponsorDisputeEvidence(auth, orderId, baseUrl(req));
    return new Response(pack.html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Disposition": `attachment; filename="sponsor-dispute-evidence-${pack.ref}.html"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    if (err instanceof AuthError) return new Response("unauthorized", { status: 401 });
    if (err instanceof HttpError) return new Response(err.message, { status: err.status });
    throw err;
  }
}
