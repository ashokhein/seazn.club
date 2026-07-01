import { sql } from "@/lib/db";
import { requireSuperadmin, logStaffAction } from "@/lib/admin";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { handler, HttpError } from "@/lib/http";
import { z } from "zod";

const schema = z.object({
  feature_key: z.string().min(1).max(80),
  bool_value: z.boolean().nullable().optional(),
  int_value: z.number().int().nullable().optional(),
  reason: z.string().min(1).max(500),
}).strict();

/** Upsert or delete an entitlement override. Superadmin only. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handler(async () => {
    const { id } = await params;
    const staff = await requireSuperadmin();
    const { feature_key, bool_value, reason, int_value } = schema.parse(await req.json());

    const [org] = await sql<{ id: string }[]>`select id from organizations where id = ${id}`;
    if (!org) throw new HttpError(404, "Organization not found");

    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, bool_value, int_value, reason)
      values (${id}, ${feature_key}, ${bool_value ?? null}, ${int_value ?? null}, ${reason})
      on conflict (org_id, feature_key) do update set
        bool_value = excluded.bool_value,
        int_value  = excluded.int_value,
        reason     = excluded.reason`;

    await invalidateOrgEntitlements(id);
    await logStaffAction(staff.id, "entitlement_override", "entitlement", id, {
      feature_key, bool_value, int_value, reason,
    });
    return { ok: true };
  });
}

/** Remove an entitlement override. Superadmin only. */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handler(async () => {
    const { id } = await params;
    const staff = await requireSuperadmin();
    const { feature_key } = z.object({ feature_key: z.string().min(1) }).strict().parse(await req.json());

    await sql`
      delete from org_entitlement_overrides
      where org_id = ${id} and feature_key = ${feature_key}`;

    await invalidateOrgEntitlements(id);
    await logStaffAction(staff.id, "entitlement_override_removed", "entitlement", id, { feature_key });
    return { ok: true };
  });
}
