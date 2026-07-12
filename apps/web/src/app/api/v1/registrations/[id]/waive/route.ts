import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { confirmRegistrationWaived } from "@/server/usecases/registrations";

type Ctx = { params: Promise<{ id: string }> };

/** Organiser: confirm while waiving the entry fee (comped entry, audited). */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "registration", id, "write");
    return confirmRegistrationWaived(auth, id);
  });
}
