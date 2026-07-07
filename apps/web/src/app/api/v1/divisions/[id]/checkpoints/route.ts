import { z } from "zod";
import { v1, reply, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { createCheckpoint, listCheckpoints } from "@/server/usecases/history";

type Ctx = { params: Promise<{ id: string }> };

const Body = z.object({ label: z.string().min(1).max(120) });

export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "division", id, "read");
    return listCheckpoints(auth, id);
  });
}

/** Named save point at the current watermark (Jul3/03 §2, 16 Jun). */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const body = await parseBody(req, Body);
    const auth = await requireResourceAuth(req, "division", id, "write");
    return reply(201, await createCheckpoint(auth, id, body.label));
  });
}
