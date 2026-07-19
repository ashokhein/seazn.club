import { z } from "zod";
import { requireSuperadmin, logStaffAction } from "@/lib/admin";
import { handler } from "@/lib/http";
import { sql } from "@/lib/db";
import { cacheDelPattern } from "@/lib/cache";
import type { AdminEntRow } from "@/lib/entitlement-admin";

const Body = z.object({
  plan_key: z.enum(["community", "event_pass", "pro", "pro_plus"]),
  feature_key: z.string().min(1).max(100),
  bool_value: z.boolean().nullable().optional(),
  int_value: z.number().int().min(0).nullable().optional(),
});

/** PATCH /api/admin/entitlements — edit one plan cell (W1 §4.5).
 *  int null = unlimited. Busts every org's cached entitlements (`ent:*`)
 *  because a plan-level row change fans out to every org on that plan. */
export async function PATCH(req: Request) {
  return handler(async () => {
    const staff = await requireSuperadmin();
    const body = Body.parse(await req.json());
    const [row] = await sql<AdminEntRow[]>`
      insert into plan_entitlements (plan_key, feature_key, bool_value, int_value)
      values (${body.plan_key}, ${body.feature_key},
              ${body.bool_value ?? null}, ${body.int_value ?? null})
      on conflict (plan_key, feature_key) do update
        set bool_value = excluded.bool_value, int_value = excluded.int_value
      returning plan_key, feature_key, bool_value, int_value`;
    await logStaffAction(
      staff.id,
      "entitlement.plan_edit",
      "entitlement",
      `${body.plan_key}:${body.feature_key}`,
      body,
    );
    await cacheDelPattern("ent:*");
    return row;
  });
}
