import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { HttpError } from "@/lib/errors";
import { listRegistrations } from "@/server/usecases/registrations";

type Ctx = { params: Promise<{ id: string }> };

const STATUSES = ["pending", "paid", "confirmed", "waitlisted", "withdrawn"];

/** Organiser registration list (?status= filter). */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "division", id, "read");
    const status = new URL(req.url).searchParams.get("status");
    if (status !== null && !STATUSES.includes(status)) {
      throw new HttpError(400, `status must be one of ${STATUSES.join(", ")}`);
    }
    return listRegistrations(auth, id, status);
  });
}
