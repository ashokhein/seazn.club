import { v1, reply, parseBody, listQuery } from "@/server/api-v1/http";
import { requireAuth } from "@/server/api-v1/auth";
import { CreateCompetition } from "@/server/api-v1/schemas";
import { listCompetitions, createCompetition } from "@/server/usecases/competitions";

export async function GET(req: Request) {
  return v1(async () => {
    const auth = await requireAuth(req, "read");
    return listCompetitions(auth, listQuery(req));
  });
}

export async function POST(req: Request) {
  return v1(async () => {
    const body = await parseBody(req, CreateCompetition);
    const auth = await requireAuth(req, "write");
    return reply(201, await createCompetition(auth, body));
  });
}
