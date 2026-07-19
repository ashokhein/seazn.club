import { v1, reply, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { CreateClubContact } from "@/server/api-v1/schemas";
import { listClubContacts, createClubContact } from "@/server/usecases/clubs";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/v1/clubs/{id}/contacts — the club's FA officers. */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "club", id, "read");
    return listClubContacts(auth, id);
  });
}

/** POST /api/v1/clubs/{id}/contacts — add a contact (single-primary enforced). */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const body = await parseBody(req, CreateClubContact);
    const auth = await requireResourceAuth(req, "club", id, "write");
    return reply(201, await createClubContact(auth, id, body));
  });
}
