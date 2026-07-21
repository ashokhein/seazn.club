import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { handler } from "@/lib/http";
import { detachOrgFromGroup } from "@/server/usecases/billing-groups";

const schema = z.object({ org_id: z.string().uuid() });

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
    return detachOrgFromGroup({ actorUserId: user.id, orgId: body.org_id });
  });
}
