import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { handler } from "@/lib/http";
import { detachOrgFromGroup } from "@/server/usecases/billing-groups";

// `mode` chooses what happens to the departing org and the seat it was on:
//  - ride_out (default): keep the plan until the paid period ends; the seat
//    follows the org, so a re-add is charged again.
//  - release: drop to Community immediately; the payer keeps the freed slot to
//    reuse for free this period.
// Defaulting to ride_out keeps the older, gentler behaviour for any caller that
// omits it, and it is the farm-safe default — a release never spends the seat.
const schema = z.object({
  org_id: z.string().uuid(),
  mode: z.enum(["ride_out", "release"]).optional(),
});

/**
 * POST /api/billing/group/detach — move an organisation out to a billing group
 * of its own (spec 2026-07-21 billing-groups §Operations 2).
 *
 * Either side may call this: the group's payer evicting an org that will not
 * pay, or the org's own owner leaving. It costs nothing and cannot be refused
 * for money reasons, so there is no payer gate here — the use case accepts
 * either party.
 */
export async function POST(req: Request) {
  return handler(async () => {
    const user = await requireUser();
    const body = schema.parse(await req.json());
    return detachOrgFromGroup({ actorUserId: user.id, orgId: body.org_id, mode: body.mode });
  });
}
