import { z } from "zod";
import { v1, reply, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { issueChallenge } from "@/server/usecases/stages";

type Ctx = { params: Promise<{ id: string }> };

const Body = z.object({ challenger_id: z.string().uuid(), opponent_id: z.string().uuid() });

/** Ladder challenge (Jul3/08 §6): creates the fixture on demand; the result
 *  reorders the ladder. Pro `formats.advanced`. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const body = await parseBody(req, Body);
    const auth = await requireResourceAuth(req, "stage", id, "write");
    return reply(201, await issueChallenge(auth, id, body));
  });
}
