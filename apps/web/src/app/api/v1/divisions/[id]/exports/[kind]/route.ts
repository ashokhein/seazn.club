import { NextResponse } from "next/server";
import { z } from "zod";
import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { HttpError } from "@/lib/errors";
import { buildDivisionDocModel } from "@/server/usecases/exports";
import { docModelToPdf, docModelToXlsx } from "@/server/doc-render";

type Ctx = { params: Promise<{ id: string; kind: string }> };

const Kind = z.enum(["timetable", "standings", "roster", "participants", "scoresheet"]);
const Breaks = z.enum(["auto", "per_pitch", "per_team", "per_division"]);

/** GET /divisions/{id}/exports/{kind}?format=pdf|xlsx&pageBreaks=&landscape=
 *  (Jul3/06 §5). Raw file response; errors keep the v1 envelope. */
export async function GET(req: Request, { params }: Ctx) {
  try {
    const { id, kind } = await params;
    const parsedKind = Kind.parse(kind);
    const auth = await requireResourceAuth(req, "division", id, "read");
    const url = new URL(req.url);
    const format = url.searchParams.get("format") ?? "pdf";
    if (format !== "pdf" && format !== "xlsx") throw new HttpError(400, "format must be pdf or xlsx");
    const model = await buildDivisionDocModel(auth, id, parsedKind, {
      printedAt: new Date().toISOString(),
      ...(url.searchParams.get("pageBreaks")
        ? { pageBreaks: Breaks.parse(url.searchParams.get("pageBreaks")) }
        : {}),
      ...(url.searchParams.get("landscape") === "true" ? { landscape: true } : {}),
      ...(url.searchParams.get("blank") === "true" ? { blank: true } : {}),
    });
    const bytes = format === "pdf" ? await docModelToPdf(model) : await docModelToXlsx(model);
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "Content-Type": format === "pdf" ? "application/pdf"
          : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${parsedKind}.${format}"`,
      },
    });
  } catch (err) {
    return v1(async () => {
      throw err;
    });
  }
}
