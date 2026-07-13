import { v1, reply } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { createCheckinLink } from "@/server/usecases/checkin-token";
import { routes } from "@/lib/routes";
import { baseUrl } from "@/lib/oauth";

type Ctx = { params: Promise<{ id: string }> };

/** Mint the fixture's check-in QR link (PROMPT-53): signed stateless token,
 *  dies at the end of the fixture's local day. Session editors only. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "fixture", id, "write");
    const { token, expires_at } = await createCheckinLink(auth, id);
    return reply(201, { url: `${baseUrl(req)}${routes.checkin(token)}`, expires_at });
  });
}
