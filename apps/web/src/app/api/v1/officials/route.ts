import { v1, reply, parseBody } from "@/server/api-v1/http";
import { requireAuth } from "@/server/api-v1/auth";
import { CreateOfficialInput, listOfficials, createOfficial } from "@/server/usecases/officials";

export async function GET(req: Request) {
  return v1(async () => {
    const auth = await requireAuth(req, "read");
    return listOfficials(auth);
  });
}

export async function POST(req: Request) {
  return v1(async () => {
    const body = await parseBody(req, CreateOfficialInput);
    const auth = await requireAuth(req, "write");
    return reply(201, await createOfficial(auth, body));
  });
}
