import { NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { v1 } from "@/server/api-v1/http";
import { requireAuth } from "@/server/api-v1/auth";
import { requireFeature } from "@/lib/entitlements";
import { HttpError } from "@/lib/errors";
import { participantRows, type ParticipantExportRow } from "@/server/usecases/clubs";

const HEADER = ["Club", "Team", "Division", "Entrant", "Player", "Number", "Position", "Captain"];

function toCells(r: ParticipantExportRow): (string | number)[] {
  return [
    r.club, r.team, r.division, r.entrant, r.player,
    r.squad_number ?? "", r.position, r.captain ? "Y" : "",
  ];
}

function csvEscape(v: string | number): string {
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/** GET /api/v1/participants/export?format=csv|xlsx&club_id=&division_id= —
 *  one sheet, club + division columns, empty-spot rows intact (Jul3/01 §6).
 *  Raw file response; errors keep the v1 envelope (`exports` is Pro). */
export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req, "read");
    await requireFeature(auth.orgId, "exports");
    const url = new URL(req.url);
    const format = url.searchParams.get("format") ?? "csv";
    if (format !== "csv" && format !== "xlsx") {
      throw new HttpError(400, "format must be csv or xlsx");
    }
    const rows = await participantRows(auth, {
      clubId: url.searchParams.get("club_id") ?? undefined,
      divisionId: url.searchParams.get("division_id") ?? undefined,
    });

    if (format === "csv") {
      const lines = [HEADER, ...rows.map(toCells)]
        .map((cells) => cells.map(csvEscape).join(","))
        .join("\r\n");
      return new NextResponse(lines, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": 'attachment; filename="participants.csv"',
        },
      });
    }
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Participants");
    sheet.addRow(HEADER).font = { bold: true };
    for (const r of rows) sheet.addRow(toCells(r));
    sheet.columns.forEach((col) => { col.width = 18; });
    const buffer = await workbook.xlsx.writeBuffer();
    return new NextResponse(buffer as unknown as ArrayBuffer, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": 'attachment; filename="participants.xlsx"',
      },
    });
  } catch (err) {
    return v1(async () => {
      throw err;
    });
  }
}
