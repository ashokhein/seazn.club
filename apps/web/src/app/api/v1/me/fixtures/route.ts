import { v1 } from "@/server/api-v1/http";
import { requireUser } from "@/lib/auth";
import { listMyFixtures } from "@/server/usecases/me";

/** The player home read (PROMPT-53): upcoming fixtures, recent results and
 *  teams for every claimed person of the caller, across all orgs. Session
 *  only — mirrors /me/assigned-fixtures. */
export async function GET() {
  return v1(async () => {
    const user = await requireUser();
    return listMyFixtures(user.id);
  });
}
