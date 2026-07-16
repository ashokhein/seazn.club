import { v1, reply, parseBody } from "@/server/api-v1/http";
import { requireOrgAuth, assertUuid } from "@/server/api-v1/auth";
import { baseUrl } from "@/lib/oauth";
import {
  StartSponsorCheckoutInput,
  listSponsorOrders,
  startSponsorCheckout,
} from "@/server/usecases/sponsors";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    assertUuid(id, "organization");
    const auth = await requireOrgAuth(req, id, "read");
    return listSponsorOrders(auth);
  });
}

/** Start a package checkout: pending order + Stripe session + invoice email
 *  to the sponsor contact. 409 when the org isn't Connect-onboarded. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    assertUuid(id, "organization");
    const body = await parseBody(req, StartSponsorCheckoutInput);
    const auth = await requireOrgAuth(req, id, "write");
    return reply(201, await startSponsorCheckout(auth, body, baseUrl(req)));
  });
}
