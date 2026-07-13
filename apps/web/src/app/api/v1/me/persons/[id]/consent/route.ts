import { v1, parseBody } from "@/server/api-v1/http";
import { requireUser } from "@/lib/auth";
import { assertUuid } from "@/server/api-v1/auth";
import { PatchMyConsent } from "@/server/api-v1/schemas";
import { setMyConsent } from "@/server/usecases/me";

type Ctx = { params: Promise<{ id: string }> };

/** Player-owned consent flags (PROMPT-53, doc 06 §4.7 handover). Guardian
 *  gate: under-16 by dob → 403 CONSENT_LOCKED, organiser values hold. The
 *  write revalidates the person's public pages immediately. Session only. */
export async function PATCH(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    assertUuid(id, "person");
    const body = await parseBody(req, PatchMyConsent);
    const user = await requireUser();
    return setMyConsent(user.id, id, body);
  });
}
