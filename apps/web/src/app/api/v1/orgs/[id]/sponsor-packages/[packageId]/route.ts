import { v1 } from "@/server/api-v1/http";
import { requireOrgAuth, assertUuid } from "@/server/api-v1/auth";
import { deactivateSponsorPackage } from "@/server/usecases/sponsors";

type Ctx = { params: Promise<{ id: string; packageId: string }> };

/** Retire a package (soft — orders reference it, so no hard delete). */
export async function DELETE(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id, packageId } = await params;
    assertUuid(id, "organization");
    assertUuid(packageId, "package");
    const auth = await requireOrgAuth(req, id, "write");
    return deactivateSponsorPackage(auth, packageId);
  });
}
