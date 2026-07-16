import { v1, parseBody } from "@/server/api-v1/http";
import { requireOrgAuth, assertUuid } from "@/server/api-v1/auth";
import { ReorderSponsorsInput, reorderSponsors } from "@/server/usecases/sponsors";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    assertUuid(id, "organization");
    const body = await parseBody(req, ReorderSponsorsInput);
    const auth = await requireOrgAuth(req, id, "write");
    return reorderSponsors(auth, body);
  });
}
