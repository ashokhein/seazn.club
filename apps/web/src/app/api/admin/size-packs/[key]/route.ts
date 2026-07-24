import { requireSuperadmin, logStaffAction } from "@/lib/admin";
import { updateSizePack, setSizePackActive } from "@/lib/size-packs";
import { handler } from "@/lib/http";
import { HttpError } from "@/lib/errors";
import { z } from "zod";

/** Editable SHAPE fields only — never the price (Stripe-owned). Every field is
 *  optional; at least one must be present. */
const schema = z
  .object({
    label: z.string().trim().min(1).max(200).optional(),
    feature_key: z.string().trim().min(1).max(64).optional(),
    delta_each: z.number().int().positive().optional(),
    stripe_lookup_key: z.string().trim().min(1).max(200).optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "Provide at least one field to edit" });

/** Edit a size-pack catalog row's shape. Superadmin only. */
export async function PATCH(req: Request, { params }: { params: Promise<{ key: string }> }) {
  return handler(async () => {
    const { key } = await params;
    const staff = await requireSuperadmin();
    const patch = schema.parse(await req.json());
    const row = await updateSizePack(key, patch);
    if (!row) throw new HttpError(404, "Size pack not found");
    await logStaffAction(staff.id, "size_pack_update", "size_pack", key, patch);
    return row;
  });
}

/** Soft-deactivate a size-pack catalog row (active=false). Superadmin only —
 *  prefer this over a hard delete so a purchased pack's catalog reference is
 *  never orphaned (already-granted packs are frozen org_addons rows regardless). */
export async function DELETE(_req: Request, { params }: { params: Promise<{ key: string }> }) {
  return handler(async () => {
    const { key } = await params;
    const staff = await requireSuperadmin();
    const row = await setSizePackActive(key, false);
    if (!row) throw new HttpError(404, "Size pack not found");
    await logStaffAction(staff.id, "size_pack_deactivate", "size_pack", key, { label: row.label });
    return row;
  });
}
