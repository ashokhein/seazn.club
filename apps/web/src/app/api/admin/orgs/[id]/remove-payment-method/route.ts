import { sql } from "@/lib/db";
import { requireStaff } from "@/lib/admin";
import { handler, HttpError } from "@/lib/http";
import { staffRemovePaymentMethod } from "@/server/usecases/billing-manage";
import { z } from "zod";

const schema = z
  .object({
    payment_method_id: z.string().min(1),
    reason: z.string().min(1).max(500),
  })
  .strict();

/** Staff-only removal of an org's card, including the default (Task 6C) — the
 *  customer-facing path refuses that on purpose (billing-manage.ts,
 *  removePaymentMethod); this is the audited escape hatch for erasure
 *  requests / fraud cleanup. Superadmin or support. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handler(async () => {
    const { id } = await params;
    const staff = await requireStaff();
    const { payment_method_id, reason } = schema.parse(await req.json());
    const [org] = await sql<{ id: string }[]>`select id from organizations where id = ${id}`;
    if (!org) throw new HttpError(404, "Organization not found");
    await staffRemovePaymentMethod(staff.id, id, payment_method_id, reason);
    return { ok: true };
  });
}
