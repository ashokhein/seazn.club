import { v1, reply, parseBody } from "@/server/api-v1/http";
import { requireOrgAuth, assertUuid } from "@/server/api-v1/auth";
import { CreateApiKey } from "@/server/api-v1/schemas";
import { listApiKeys, createApiKey } from "@/server/usecases/api-keys";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    assertUuid(id, "organization");
    const auth = await requireOrgAuth(req, id, "write"); // key management = editors
    return listApiKeys(auth);
  });
}

/** Mint a key: the sk_live_ secret appears in this response only (doc 08 §2). */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    assertUuid(id, "organization");
    const body = await parseBody(req, CreateApiKey);
    const auth = await requireOrgAuth(req, id, "write");
    return reply(201, await createApiKey(auth, body));
  });
}
