import { v1, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { PutProfile } from "@/server/api-v1/schemas";
import { getProfile, putProfile } from "@/server/usecases/persons";

type Ctx = { params: Promise<{ id: string; sport: string }> };

export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id, sport } = await params;
    const auth = await requireResourceAuth(req, "person", id, "read");
    return getProfile(auth, id, sport);
  });
}

export async function PUT(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id, sport } = await params;
    const body = await parseBody(req, PutProfile);
    const auth = await requireResourceAuth(req, "person", id, "write");
    return putProfile(auth, id, sport, body);
  });
}
