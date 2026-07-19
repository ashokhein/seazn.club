import { v1 } from "@/server/api-v1/http";
import { requireUser } from "@/lib/auth";
import { assertUuid } from "@/server/api-v1/auth";
import { submitMyReport } from "@/server/usecases/match-reports";

type Ctx = { params: Promise<{ fixtureOfficialId: string }> };

/** Submit the draft (immutable thereafter, 409 on resubmit). Fires the soft
 *  SPEC-1 bridge: misconduct/red-card incidents naming a person suggest
 *  pending suspensions when the org enforces discipline. Session only. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { fixtureOfficialId } = await params;
    assertUuid(fixtureOfficialId, "assignment");
    const user = await requireUser();
    return submitMyReport(user.id, fixtureOfficialId);
  });
}
