import { requireSuperadmin } from "@/lib/admin";
import { updateSizePack, setSizePackActive } from "@/lib/size-packs";
import { sql } from "@/lib/db";
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
    // Catalog edit + its audit row commit together (extend #272); local DB only.
    const row = await sql.begin(async (tx) => {
      const r = await updateSizePack(key, patch, tx);
      if (!r) return null; // 404 below — nothing written, nothing to audit
      await tx`
        insert into staff_audit_log (actor_id, action, target_type, target_id, detail)
        values (${staff.id}, 'size_pack_update', 'size_pack', ${key}, ${tx.json(patch as never)})`;
      return r;
    });
    if (!row) throw new HttpError(404, "Size pack not found");
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
    // Soft-deactivate + its audit row commit together (extend #272); local DB only.
    const row = await sql.begin(async (tx) => {
      const r = await setSizePackActive(key, false, tx);
      if (!r) return null; // 404 below — nothing written, nothing to audit
      await tx`
        insert into staff_audit_log (actor_id, action, target_type, target_id, detail)
        values (${staff.id}, 'size_pack_deactivate', 'size_pack', ${key}, ${tx.json({ label: r.label } as never)})`;
      return r;
    });
    if (!row) throw new HttpError(404, "Size pack not found");
    return row;
  });
}
