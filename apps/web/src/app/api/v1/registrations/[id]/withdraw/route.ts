import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { withdrawRegistrationOrganiser } from "@/server/usecases/registrations";

type Ctx = { params: Promise<{ id: string }> };

/** Organiser withdraw: frees the spot, auto-promotes the waitlist, applies
 *  the auto-refund policy (doc 16 §1.1). */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "registration", id, "write");
    return withdrawRegistrationOrganiser(auth, id);
  });
}
