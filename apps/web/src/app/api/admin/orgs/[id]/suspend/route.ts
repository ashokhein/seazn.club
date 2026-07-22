import { sql } from "@/lib/db";
import { requireSuperadmin, logStaffAction } from "@/lib/admin";
import { handler, HttpError } from "@/lib/http";
import { z } from "zod";

const schema = z.object({
  action: z.enum(["suspend", "reactivate"]),
  reason: z.string().min(1).max(500),
}).strict();

/** Suspend or reactivate an organization. Superadmin only. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handler(async () => {
    const { id } = await params;
    const staff = await requireSuperadmin();
    const { action, reason } = schema.parse(await req.json());

    const [org] = await sql<{ id: string }[]>`select id from organizations where id = ${id}`;
    if (!org) throw new HttpError(404, "Organization not found");

    // organizations.status ONLY. Suspension used to also stamp
    // subscriptions.status = 'suspended', which was harmless while a
    // subscription belonged to exactly one org. Since V310 a subscription is a
    // shared BILLING GROUP: writing to it would stop billing and degrade
    // entitlements for every OTHER org in the group — orgs that may belong to
    // uninvolved people and have done nothing wrong. Suspension is moderation,
    // not billing, so the money and the plan are left completely alone and a
    // suspended org keeps counting toward the group's paid quantity
    // (billing-group.ts activeOrgCount).
    const newStatus = action === "suspend" ? "suspended" : "active";
    await sql`update organizations set status = ${newStatus} where id = ${id}`;

    await logStaffAction(staff.id, action, "org", id, { reason });
    return { ok: true, status: newStatus };
  });
}
