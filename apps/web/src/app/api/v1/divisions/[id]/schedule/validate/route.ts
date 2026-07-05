import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { validateSchedule } from "@/server/usecases/schedule";

type Ctx = { params: Promise<{ id: string }> };

/** Full conflict report over the division's board (doc 12 §4 — board load
 *  and the debounced re-validation after edits). */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "division", id, "read");
    return validateSchedule(auth, id);
  });
}
