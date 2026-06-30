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

    const newStatus = action === "suspend" ? "suspended" : "active";
    await sql`update organizations set status = ${newStatus} where id = ${id}`;

    if (action === "suspend") {
      await sql`
        update subscriptions set status = 'suspended', updated_at = now()
        where org_id = ${id}`;
    }

    await logStaffAction(staff.id, action, "org", id, { reason });
    return { ok: true, status: newStatus };
  });
}
