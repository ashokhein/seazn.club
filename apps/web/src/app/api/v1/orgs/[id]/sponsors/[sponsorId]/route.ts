import { v1, parseBody } from "@/server/api-v1/http";
import { requireOrgAuth, assertUuid } from "@/server/api-v1/auth";
import { PatchSponsorInput, patchSponsor, deleteSponsor } from "@/server/usecases/sponsors";

type Ctx = { params: Promise<{ id: string; sponsorId: string }> };

export async function PATCH(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id, sponsorId } = await params;
    assertUuid(id, "organization");
    assertUuid(sponsorId, "sponsor");
    const body = await parseBody(req, PatchSponsorInput);
    const auth = await requireOrgAuth(req, id, "write");
    return patchSponsor(auth, sponsorId, body);
  });
}

export async function DELETE(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id, sponsorId } = await params;
    assertUuid(id, "organization");
    assertUuid(sponsorId, "sponsor");
    const auth = await requireOrgAuth(req, id, "write");
    await deleteSponsor(auth, sponsorId);
    return { deleted: true };
  });
}
