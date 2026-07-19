import { v1 } from "@/server/api-v1/http";
import { requireOrgAuth, assertUuid } from "@/server/api-v1/auth";
import { createConnectDashboardLink } from "@/server/usecases/stripe-connect";

type Ctx = { params: Promise<{ id: string }> };

/** Mint a one-time Stripe Express Dashboard login link (owner-only). */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    assertUuid(id, "organization");
    const auth = await requireOrgAuth(req, id, "write");
    return createConnectDashboardLink(auth, id);
  });
}
