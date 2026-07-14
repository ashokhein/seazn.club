import { requireResourceAuth } from "@/server/api-v1/auth";
import { buildDisputeEvidence } from "@/server/usecases/registrations";
import { baseUrl } from "@/lib/oauth";
import { AuthError, HttpError } from "@/lib/errors";

type Ctx = { params: Promise<{ id: string }> };

/** Organiser: download the dispute evidence pack for a registration as a
 *  printable HTML document. Raw Response (an attachment), so this skips the
 *  v1 JSON envelope — auth is still the v1 resource door. */
export async function GET(req: Request, { params }: Ctx) {
  const { id } = await params;
  try {
    const auth = await requireResourceAuth(req, "registration", id, "write");
    const pack = await buildDisputeEvidence(auth, id, baseUrl(req));
    return new Response(pack.html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Disposition": `attachment; filename="dispute-evidence-${pack.ref}.html"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    if (err instanceof AuthError) return new Response("unauthorized", { status: 401 });
    if (err instanceof HttpError) return new Response(err.message, { status: err.status });
    throw err;
  }
}
