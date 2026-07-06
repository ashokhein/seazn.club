import { NextResponse } from "next/server";
import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { exportRegistrationsCsv } from "@/server/usecases/registrations";

type Ctx = { params: Promise<{ id: string }> };

/** CSV export (`exports` entitlement). Raw text/csv — not the JSON envelope;
 *  errors still flow through v1() so 402/404 keep the standard shape. */
export async function GET(req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "division", id, "read");
    const csv = await exportRegistrationsCsv(auth, id);
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="registrations-${id}.csv"`,
      },
    });
  } catch (err) {
    return v1(async () => {
      throw err;
    });
  }
}
