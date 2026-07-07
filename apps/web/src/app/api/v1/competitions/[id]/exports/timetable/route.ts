import { NextResponse } from "next/server";
import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { buildCompetitionTimetable } from "@/server/usecases/exports";
import { docModelToPdf } from "@/server/doc-render";

type Ctx = { params: Promise<{ id: string }> };

/** GET /competitions/{id}/exports/timetable?pretty=true — the 2-Jul "pretty
 *  timetable PDF" across all divisions (Jul3/06 §5). */
export async function GET(req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "competition", id, "read");
    const model = await buildCompetitionTimetable(auth, id, {
      printedAt: new Date().toISOString(),
    });
    const bytes = await docModelToPdf(model);
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": 'attachment; filename="timetable.pdf"',
      },
    });
  } catch (err) {
    return v1(async () => {
      throw err;
    });
  }
}
