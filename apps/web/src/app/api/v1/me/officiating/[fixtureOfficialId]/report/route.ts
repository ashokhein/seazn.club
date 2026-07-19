import { v1, parseBody } from "@/server/api-v1/http";
import { requireUser } from "@/lib/auth";
import { assertUuid } from "@/server/api-v1/auth";
import { PutReportBody } from "@/server/api-v1/schemas";
import { getMyReport, putMyReport } from "@/server/usecases/match-reports";

type Ctx = { params: Promise<{ fixtureOfficialId: string }> };

/** The caller's match report for one of their accepted assignments (SPEC-3,
 *  cross-org rail). Session only — the usecase proves the claimed-official
 *  identity (404 if the assignment isn't theirs). null when nothing filed. */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { fixtureOfficialId } = await params;
    assertUuid(fixtureOfficialId, "assignment");
    const user = await requireUser();
    return getMyReport(user.id, fixtureOfficialId);
  });
}

/** Save the draft body + incident rows (free portal principle). Draft only —
 *  a submitted report is immutable (409). Window enforced in the usecase. */
export async function PUT(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { fixtureOfficialId } = await params;
    assertUuid(fixtureOfficialId, "assignment");
    const body = await parseBody(req, PutReportBody);
    const user = await requireUser();
    return putMyReport(user.id, fixtureOfficialId, body);
  });
}
