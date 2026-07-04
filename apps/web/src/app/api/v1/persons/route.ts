import { v1, reply, parseBody, listQuery } from "@/server/api-v1/http";
import { requireAuth } from "@/server/api-v1/auth";
import { CreatePerson } from "@/server/api-v1/schemas";
import { listPersons, createPerson } from "@/server/usecases/persons";

export async function GET(req: Request) {
  return v1(async () => {
    const auth = await requireAuth(req, "read");
    return listPersons(auth, listQuery(req));
  });
}

export async function POST(req: Request) {
  return v1(async () => {
    const body = await parseBody(req, CreatePerson);
    const auth = await requireAuth(req, "write");
    return reply(201, await createPerson(auth, body));
  });
}
