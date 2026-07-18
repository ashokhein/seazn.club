import { NextResponse } from "next/server";
import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { HttpError } from "@/lib/errors";
import { buildAdmitTicketsDoc } from "@/server/usecases/exports";
import { docModelToPdf } from "@/server/doc-render";

type Ctx = { params: Promise<{ id: string }> };

/** GET /competitions/{id}/exports/tickets?format=pdf — 2-up admit tickets for
 *  every confirmed registration (v12/Task 14). PDF only — the QR is visual,
 *  there is no tabular XLSX form for a ticket. Raw file response; errors
 *  keep the v1 envelope. */
export async function GET(req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "competition", id, "read");
    const url = new URL(req.url);
    const format = url.searchParams.get("format") ?? "pdf";
    if (format !== "pdf") throw new HttpError(400, "format must be pdf");
    const model = await buildAdmitTicketsDoc(
      auth, id, { printedAt: new Date().toISOString() }, url.origin,
    );
    const bytes = await docModelToPdf(model);
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": 'attachment; filename="tickets.pdf"',
      },
    });
  } catch (err) {
    return v1(async () => {
      throw err;
    });
  }
}
