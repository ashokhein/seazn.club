import { sql } from "@/lib/db";
import { requireStaff } from "@/lib/admin";
import { handler, HttpError } from "@/lib/http";
import { extendTrial } from "@/server/usecases/admin-plan";
import { z } from "zod";

const schema = z
  .object({
    days: z.number().int().min(1).max(365),
    reason: z.string().min(1).max(500),
  })
  .strict();

/** Extend/grant trial (v3/08 §1). Also updates Stripe's trial_end when a
 *  subscription exists, so both systems agree. Superadmin or support. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handler(async () => {
    const { id } = await params;
    const staff = await requireStaff();
    const { days, reason } = schema.parse(await req.json());
    const [org] = await sql<{ id: string }[]>`select id from organizations where id = ${id}`;
    if (!org) throw new HttpError(404, "Organization not found");
    const trialEnd = await extendTrial(staff.id, id, days, reason);
    return { ok: true, trial_end: trialEnd };
  });
}
