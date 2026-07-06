import { NextResponse } from "next/server";
import { v1 } from "@/server/api-v1/http";
import { HttpError } from "@/lib/errors";
import { assertUuid } from "@/server/api-v1/auth";
import { publicRateLimit } from "@/server/usecases/public";
import { registrationIcs } from "@/server/usecases/registrations";

type Ctx = { params: Promise<{ id: string }> };

/** Confirmation .ics (competition dates). Raw text/calendar — errors keep
 *  the JSON envelope via v1(). */
export async function GET(req: Request, { params }: Ctx) {
  try {
    await publicRateLimit(req);
    const { id } = await params;
    assertUuid(id, "registration");
    const token = new URL(req.url).searchParams.get("token");
    if (!token) throw new HttpError(401, "token required");
    const ics = await registrationIcs(id, token);
    return new NextResponse(ics, {
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        "Content-Disposition": `attachment; filename="registration-${id}.ics"`,
      },
    });
  } catch (err) {
    return v1(async () => {
      throw err;
    });
  }
}
