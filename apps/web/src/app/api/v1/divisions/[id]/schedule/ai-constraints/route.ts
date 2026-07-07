import { z } from "zod";
import { v1, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { aiConstraintsForDivision } from "@/server/usecases/schedule-plus";

type Ctx = { params: Promise<{ id: string }> };

const Body = z.object({ prose: z.string().min(3).max(4000) });

/** Prose → Zod-validated SchedulingConstraints (Jul3/04 §5). Propose-only —
 *  the organiser reviews and applies via schedule-settings. Pro `scheduling.ai`. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const body = await parseBody(req, Body);
    const auth = await requireResourceAuth(req, "division", id, "write");
    return aiConstraintsForDivision(auth, id, body.prose);
  });
}
