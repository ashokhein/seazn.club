import { NextResponse } from "next/server";
import { z } from "zod";
import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { HttpError } from "@/lib/errors";
import { buildDivisionDocModel, buildOfficialsRotaDoc } from "@/server/usecases/exports";
import { docModelToPdf, docModelToXlsx } from "@/server/doc-render";

type Ctx = { params: Promise<{ id: string; kind: string }> };

const Kind = z.enum([
  "timetable", "standings", "roster", "participants", "scoresheet", "officials_rota",
  "bracket", // PROMPT-62 §4 — landscape results poster, pdf-only
]);
const Breaks = z.enum(["auto", "per_pitch", "per_team", "per_division"]);

/** GET /divisions/{id}/exports/{kind}?format=pdf|xlsx&pageBreaks=&landscape=
 *  (Jul3/06 §5; officials_rota added v12/Task 14). Raw file response; errors
 *  keep the v1 envelope. */
export async function GET(req: Request, { params }: Ctx) {
  try {
    const { id, kind } = await params;
    const parsedKind = Kind.parse(kind);
    const auth = await requireResourceAuth(req, "division", id, "read");
    const url = new URL(req.url);
    const format = url.searchParams.get("format") ?? "pdf";
    if (format !== "pdf" && format !== "xlsx") throw new HttpError(400, "format must be pdf or xlsx");
    if (parsedKind === "bracket" && format !== "pdf") {
      throw new HttpError(422, "the bracket poster is a PDF-only export");
    }
    const opts = {
      printedAt: new Date().toISOString(),
      ...(url.searchParams.get("pageBreaks")
        ? { pageBreaks: Breaks.parse(url.searchParams.get("pageBreaks")) }
        : {}),
      ...(url.searchParams.get("landscape") === "true" ? { landscape: true } : {}),
      ...(url.searchParams.get("blank") === "true" ? { blank: true } : {}),
    };
    const model = parsedKind === "officials_rota"
      ? await buildOfficialsRotaDoc(auth, id, opts)
      : await buildDivisionDocModel(auth, id, parsedKind, opts);
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
