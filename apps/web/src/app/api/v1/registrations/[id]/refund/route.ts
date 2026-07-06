import { v1, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { RefundRegistration } from "@/server/api-v1/schemas";
import { refundRegistration } from "@/server/usecases/registrations";

type Ctx = { params: Promise<{ id: string }> };

/** Manual refund (post-lock organiser discretion; partial allowed; audited). */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "registration", id, "write");
    const input = await parseBody(req, RefundRegistration);
    return refundRegistration(auth, id, input.amount_cents);
  });
}
