import { v1 } from "@/server/api-v1/http";
import { requireUser } from "@/lib/auth";
import { listMyPersons } from "@/server/usecases/me";

/** My claimed player profiles across orgs, with consent state (PROMPT-53).
 *  dob never rides out — only the derived consent_locked flag. Session only. */
export async function GET() {
  return v1(async () => {
    const user = await requireUser();
    return listMyPersons(user.id);
  });
}
