import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { completeStage } from "@/server/usecases/stages";

type Ctx = { params: Promise<{ id: string }> };

/** Guarded progression: no-op unless the stage's completion predicate holds. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "stage", id, "write");
    return completeStage(auth, id);
  });
}
