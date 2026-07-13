import { handler } from "@/lib/http";
import { requireUser } from "@/lib/auth";
import { claimPerson } from "@/server/usecases/person-claims";

type Ctx = { params: Promise<{ token: string }> };

/** Accept a claim (PROMPT-53): link persons.user_id to the logged-in caller.
 *  Racing accepts are resolved in the usecase — exactly one wins. */
export async function POST(_req: Request, { params }: Ctx) {
  return handler(async () => {
    const user = await requireUser();
    const { token } = await params;
    const claim = await claimPerson(token, user.id, user.email);
    return {
      person_id: claim.person_id,
      person_name: claim.person_name,
      org_name: claim.org_name,
    };
  });
}
