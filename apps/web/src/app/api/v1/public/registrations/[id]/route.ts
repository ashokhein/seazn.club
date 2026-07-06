import { v1 } from "@/server/api-v1/http";
import { HttpError } from "@/lib/errors";
import { assertUuid } from "@/server/api-v1/auth";
import { publicRateLimit } from "@/server/usecases/public";
import {
  publicRegistrationStatus,
  reconcileRegistration,
} from "@/server/usecases/registrations";

type Ctx = { params: Promise<{ id: string }> };

/** Registrant status view (?token= is the credential; ?reconcile=1 after a
 *  checkout return pulls the session from Stripe when the webhook is slow). */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    await publicRateLimit(req);
    const { id } = await params;
    assertUuid(id, "registration");
    const url = new URL(req.url);
    const token = url.searchParams.get("token");
    if (!token) throw new HttpError(401, "token required");
    if (url.searchParams.get("reconcile") === "1") {
      await reconcileRegistration(id, token); // best-effort, never throws
    }
    return publicRegistrationStatus(id, token);
  });
}
