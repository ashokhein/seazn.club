import { v1 } from "@/server/api-v1/http";
import { requireUser } from "@/lib/auth";
import { assertUuid } from "@/server/api-v1/auth";
import { myFixtureSquad } from "@/server/usecases/match-reports";

type Ctx = { params: Promise<{ fixtureOfficialId: string }> };

/** Both entrants' squads behind the caller's assignment — the optional person
 *  picker on the match-report form (SPEC-3). Session only (cross-org rail); the
 *  usecase proves the claimed-official identity (404 if not theirs). Free. */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { fixtureOfficialId } = await params;
    assertUuid(fixtureOfficialId, "assignment");
    const user = await requireUser();
    return myFixtureSquad(user.id, fixtureOfficialId);
  });
}
