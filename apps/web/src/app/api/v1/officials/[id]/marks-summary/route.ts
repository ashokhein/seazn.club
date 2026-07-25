import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { orgMarksSummary } from "@/server/usecases/official-marks";

type Ctx = { params: Promise<{ id: string }> };

/** Org-scoped mark average + count + recent comments for an official (SPEC-3,
 *  console). Available on every plan (V319 ungated marks — no entitlement gate,
 *  no 402). */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "official", id, "read");
    return orgMarksSummary(auth, id);
  });
}
