import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { divisionScheduleReport } from "@/server/usecases/schedule-plus";

type Ctx = { params: Promise<{ id: string }> };

/** Wait-time diagnostics before publish (Jul3/04 §4, 16 Sep). All plans. */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "division", id, "read");
    return divisionScheduleReport(auth, id);
  });
}
