import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { generateStageFixtures } from "@/server/usecases/stages";

type Ctx = { params: Promise<{ id: string }> };

/** Generate fixtures for a stage — idempotent, returns the diff (doc 08 §3). */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "stage", id, "write");
    return generateStageFixtures(auth, id);
  });
}
