import { sql } from "@/lib/db";
import { requireStaff } from "@/lib/admin";
import { handler, HttpError } from "@/lib/http";
import { restoreTrial } from "@/server/usecases/admin-plan";
import { z } from "zod";

const schema = z.object({ reason: z.string().min(1).max(500) }).strict();

/** Give an org its 14-day trial back (v3/08 §1). Superadmin or support — the
 *  sanctioned undo for the one-trial-per-org rule, audited like every other
 *  plan action. Refuses a live Stripe subscription: the usecase enforces this
 *  because the next sync would just re-stamp the burn. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handler(async () => {
    const { id } = await params;
    const staff = await requireStaff();
    const { reason } = schema.parse(await req.json());
    const [org] = await sql<{ id: string }[]>`select id from organizations where id = ${id}`;
    if (!org) throw new HttpError(404, "Organization not found");
    await restoreTrial(staff.id, id, reason);
    return { ok: true };
  });
}
