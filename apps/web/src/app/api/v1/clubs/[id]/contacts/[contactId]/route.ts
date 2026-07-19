import { v1, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { PatchClubContact } from "@/server/api-v1/schemas";
import { patchClubContact, deleteClubContact } from "@/server/usecases/clubs";

type Ctx = { params: Promise<{ id: string; contactId: string }> };

/** PATCH /api/v1/clubs/{id}/contacts/{contactId} — edit a contact. */
export async function PATCH(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id, contactId } = await params;
    const body = await parseBody(req, PatchClubContact);
    const auth = await requireResourceAuth(req, "club", id, "write");
    return patchClubContact(auth, id, contactId, body);
  });
}

/** DELETE /api/v1/clubs/{id}/contacts/{contactId} — remove a contact. */
export async function DELETE(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id, contactId } = await params;
    const auth = await requireResourceAuth(req, "club", id, "write");
    await deleteClubContact(auth, id, contactId);
    return { deleted: true };
  });
}
