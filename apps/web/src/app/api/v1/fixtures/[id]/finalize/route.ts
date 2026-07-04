import { z } from "zod";
import { v1, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { finalizeFixture } from "@/server/usecases/scoring";

type Ctx = { params: Promise<{ id: string }> };

const Body = z.object({ expected_seq: z.number().int().min(0) });

/** Lock the ledger: appends core.finalize through the scoring path. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const body = await parseBody(req, Body);
    const auth = await requireResourceAuth(req, "fixture", id, "write");
    return finalizeFixture(auth, id, body.expected_seq);
  });
}
