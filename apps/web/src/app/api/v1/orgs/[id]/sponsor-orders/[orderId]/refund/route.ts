import { v1 } from "@/server/api-v1/http";
import { requireOrgAuth, assertUuid } from "@/server/api-v1/auth";
import { refundSponsorOrder } from "@/server/usecases/sponsors";

type Ctx = { params: Promise<{ id: string; orderId: string }> };

/** Full refund of a paid sponsor order — transfer reversed, platform fee
 *  returned, placement taken off the public pages. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id, orderId } = await params;
    assertUuid(id, "organization");
    assertUuid(orderId, "order");
    const auth = await requireOrgAuth(req, id, "write");
    return refundSponsorOrder(auth, orderId);
  });
}
