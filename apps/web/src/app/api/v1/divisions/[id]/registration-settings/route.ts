import { v1, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { PutRegistrationSettings } from "@/server/api-v1/schemas";
import {
  getRegistrationSettings,
  putRegistrationSettings,
} from "@/server/usecases/registrations";

type Ctx = { params: Promise<{ id: string }> };

/** Division registration settings (doc 16 §1.1, PROMPT-20a). */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "division", id, "read");
    return getRegistrationSettings(auth, id);
  });
}

/** Upsert; entry fees (fee_cents > 0) are `registration.paid` (Pro). */
export async function PUT(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "division", id, "write");
    const input = await parseBody(req, PutRegistrationSettings);
    return putRegistrationSettings(auth, id, input);
  });
}
