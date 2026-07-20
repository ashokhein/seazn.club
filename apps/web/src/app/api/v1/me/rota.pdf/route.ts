import { NextResponse } from "next/server";
import { v1 } from "@/server/api-v1/http";
import { requireUser } from "@/lib/auth";
import { buildMyRotaDoc } from "@/server/usecases/exports";
import { docModelToPdf } from "@/server/doc-render";

/** GET /me/rota.pdf — the caller's own officiating rota across every
 *  organisation (v12/Task 14). Session-only, no org tenant and no
 *  entitlement gate: the officiating portal is free, and the doc is scoped
 *  by getMyOfficiating(userId), never by org membership. Raw file response;
 *  errors keep the v1 envelope. */
export async function GET() {
  try {
    const user = await requireUser();
    const model = await buildMyRotaDoc(user.id, { printedAt: new Date().toISOString() });
    const bytes = await docModelToPdf(model);
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": 'attachment; filename="my-rota.pdf"',
      },
    });
  } catch (err) {
    return v1(async () => {
      throw err;
    });
  }
}
