import { requireStaff, requireSuperadmin, logStaffAction } from "@/lib/admin";
import { listSizePacks, createSizePack } from "@/lib/size-packs";
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
    const row = await createSizePack(input);
    await logStaffAction(staff.id, "size_pack_create", "size_pack", row.key, {
      label: row.label,
      feature_key: row.feature_key,
      delta_each: row.delta_each,
      stripe_lookup_key: row.stripe_lookup_key,
    });
    return row;
  });
}
