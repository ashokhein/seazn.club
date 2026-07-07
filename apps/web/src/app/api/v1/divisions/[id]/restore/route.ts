import { z } from "zod";
import { v1, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { restoreCheckpoint } from "@/server/usecases/history";

type Ctx = { params: Promise<{ id: string }> };

const Body = z.object({
  checkpoint_id: z.string().uuid(),
  confirm: z.literal(true), // double-submit guard (Jul3/03 §6)
});

/** Undo back to a checkpoint's watermark (results-guarded). */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const body = await parseBody(req, Body);
    const auth = await requireResourceAuth(req, "division", id, "write");
    return restoreCheckpoint(auth, id, body.checkpoint_id, body.confirm);
  });
}
