import { createOrgForUser, getUserOrgs, requireUser, setActiveOrgId } from "@/lib/auth";
import { handler } from "@/lib/http";
import { createOrgSchema } from "@/lib/types";

/** List the organizations the current user belongs to (with their role). */
export async function GET() {
  return handler(async () => {
    const user = await requireUser();
    return getUserOrgs(user.id);
  });
}

/** Create a new organization; the creator becomes its owner. Slug is auto.
 *  Optionally attach it onto an existing billing group the actor pays for
 *  (#212); absent = its own bill, the default. */
export async function POST(req: Request) {
  return handler(async () => {
    const user = await requireUser();
    const { name, attachToGroupId } = createOrgSchema.parse(await req.json());
    const org = await createOrgForUser(user.id, name);
    await setActiveOrgId(org.id);
    if (!attachToGroupId) return org;
    try {
      // Dynamic import keeps the Stripe-touching usecase out of this module's
      // static graph — matches createOrgForUser's own pattern.
      const { attachOrgToGroup } = await import("@/server/usecases/billing-groups");
      const res = await attachOrgToGroup({ actorUserId: user.id, orgId: org.id, subscriptionId: attachToGroupId });
      return { ...org, attach: { ok: true, charged: res.charged } };
    } catch (err) {
      // The org already exists on its own bill — the new default. Surface why
      // it did not join rather than failing the whole creation.
      const reason = err instanceof Error ? err.message : "Could not add it to that bill.";
      console.error(`[billing] create-org attach to ${attachToGroupId} failed for org ${org.id}`, err);
      return { ...org, attach: { ok: false, reason } };
    }
  });
}
