import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth, assertUuid } from "@/server/api-v1/auth";
import { revokeDeviceLink } from "@/server/usecases/device-links";

type Ctx = { params: Promise<{ id: string; linkId: string }> };

/** Revoke a device link (doc 13 §7): immediate 401 for the holder. */
export async function DELETE(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id, linkId } = await params;
    assertUuid(linkId, "device link");
    const auth = await requireResourceAuth(req, "fixture", id, "write");
    return revokeDeviceLink(auth, id, linkId);
  });
}
