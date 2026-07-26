import { requireStaff, requireSuperadmin } from "@/lib/admin";
import { listSizePacks, createSizePack } from "@/lib/size-packs";
import { sql } from "@/lib/db";
import { handler } from "@/lib/http";
import { z } from "zod";

/** List the size-pack catalog. Any staff. */
export async function GET() {
  return handler(async () => {
    await requireStaff();
    return listSizePacks();
  });
}

const schema = z
  .object({
    key: z.string().trim().min(1).max(64),
    label: z.string().trim().min(1).max(200),
    feature_key: z.string().trim().min(1).max(64),
    delta_each: z.number().int().positive(),
    stripe_lookup_key: z.string().trim().min(1).max(200),
    active: z.boolean().optional(),
  })
  .strict();

/** Create a size-pack catalog row. Superadmin only (money-path config). The
 *  PRICE is Stripe-owned (stripe-plans.json + stripe:sync, keyed by
 *  stripe_lookup_key); this only edits the SHAPE the checkout snapshots. */
export async function POST(req: Request) {
  return handler(async () => {
    const staff = await requireSuperadmin();
    const input = schema.parse(await req.json());
    // The catalog insert and its staff_audit_log row commit TOGETHER (extend
    // #272): a crash between them can never leave a money-path config change
    // unaudited. No Stripe call here — the PRICE is Stripe-owned but never
    // written on this path, so the whole atomic unit is local DB.
    return sql.begin(async (tx) => {
      const row = await createSizePack(input, tx);
      await tx`
        insert into staff_audit_log (actor_id, action, target_type, target_id, detail)
        values (${staff.id}, 'size_pack_create', 'size_pack', ${row.key}, ${tx.json({
          label: row.label,
          feature_key: row.feature_key,
          delta_each: row.delta_each,
          stripe_lookup_key: row.stripe_lookup_key,
        } as never)})`;
      return row;
    });
  });
}
