import { sql } from "@/lib/db";
import { requireStaff, logStaffAction } from "@/lib/admin";
import { handler, HttpError } from "@/lib/http";
import { z } from "zod";

const schema = z.object({ days: z.number().int().min(1).max(365) }).strict();

/** Extend/grant trial for an org. Superadmin or support. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handler(async () => {
    const { id } = await params;
    const staff = await requireStaff();
    const { days } = schema.parse(await req.json());

    const trialEnd = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    const [org] = await sql<{ id: string }[]>`select id from organizations where id = ${id}`;
    if (!org) throw new HttpError(404, "Organization not found");

    await sql`
      update subscriptions set
        status    = 'trialing',
        trial_end = ${trialEnd.toISOString()},
        updated_at = now()
      where org_id = ${id}`;

    await logStaffAction(staff.id, "grant_trial", "org", id, { days, trial_end: trialEnd.toISOString() });
    return { ok: true, trial_end: trialEnd.toISOString() };
  });
}
