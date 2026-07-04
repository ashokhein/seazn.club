import { v1 } from "@/server/api-v1/http";
import { requireOrgAuth, assertUuid } from "@/server/api-v1/auth";
import { revokeApiKey } from "@/server/usecases/api-keys";

type Ctx = { params: Promise<{ id: string; keyId: string }> };

/** Revoke (idempotent) — the key stops authenticating immediately. */
export async function DELETE(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id, keyId } = await params;
    assertUuid(id, "organization");
    assertUuid(keyId, "API key");
    const auth = await requireOrgAuth(req, id, "write");
    return revokeApiKey(auth, keyId);
  });
}
