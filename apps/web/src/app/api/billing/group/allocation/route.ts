import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { handler } from "@/lib/http";
import { allocationConsole, setOrgAllocation } from "@/server/usecases/operator-allocation";

const schema = z.object({
  org_id: z.string().uuid(),
  monthly_cap: z.number().int().nonnegative().nullable(),
});

/**
 * GET /api/billing/group/allocation — the operator allocation console
 * (design/v17-pricing-entitlements/SPEC-5 §1): every member org's cap, its burn
 * this period, and the shared pool balance for the caller's group wallet.
 *
 * Payer-gated exactly like the sibling group routes (attach/detach/transfer):
 * `requireUser` establishes who is asking, and `allocationConsole` gates on
 * `subscriptions.owner_user_id` — a non-payer resolves to no owned group and
 * gets a 403.
 */
export async function GET() {
  return handler(async () => {
    const user = await requireUser();
    return allocationConsole(user.id);
  });
}

/**
 * PUT /api/billing/group/allocation — set (or clear) a member org's monthly
 * credit cap on the shared wallet. `monthly_cap: null` clears to an unlimited
 * share. Payer-only; an org outside the caller's group is refused (403/404) by
 * the use case's `subscriptionIsOwnedBy` gate.
 */
export async function PUT(req: Request) {
  return handler(async () => {
    const user = await requireUser();
    const body = schema.parse(await req.json());
    return setOrgAllocation(user.id, body.org_id, body.monthly_cap);
  });
}
