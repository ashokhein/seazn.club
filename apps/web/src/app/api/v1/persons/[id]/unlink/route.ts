import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { unlinkPerson } from "@/server/usecases/person-claims";

type Ctx = { params: Promise<{ id: string }> };

/** Staff unlink (PROMPT-53): detach the player login, revoke live claims.
 *  Claim rows stay — claimed_at + revoked_at are the audit trail. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "person", id, "write");
    await unlinkPerson(auth, id);
    return { unlinked: true };
  });
}
