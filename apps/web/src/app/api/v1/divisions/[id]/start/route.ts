import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { startDivision } from "@/server/usecases/schedule";

type Ctx = { params: Promise<{ id: string }> };

/** The "start tournament" action (doc 12 §1 — both launch modes end here).
 *  Quick-start generates the first stage's fixtures when none exist. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "division", id, "write");
    return startDivision(auth, id);
  });
}
