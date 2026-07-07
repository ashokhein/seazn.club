import { v1, reply, parseBody } from "@/server/api-v1/http";
import { requireAuth } from "@/server/api-v1/auth";
import { CreateClub } from "@/server/api-v1/schemas";
import { listClubs, createClub } from "@/server/usecases/clubs";

export async function GET(req: Request) {
  return v1(async () => {
    const auth = await requireAuth(req, "read");
    return listClubs(auth);
  });
}

export async function POST(req: Request) {
  return v1(async () => {
    const body = await parseBody(req, CreateClub);
    const auth = await requireAuth(req, "write");
    return reply(201, await createClub(auth, body));
  });
}
