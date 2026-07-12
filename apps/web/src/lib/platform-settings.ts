import "server-only";
// Platform-wide admin knobs (spec 2026-07-12 §1). One row per key in
// platform_settings; the table is superuser-only (never exposed to tenant
// connections or the Data API). Values cache like entitlements: cache-aside,
// short TTL, invalidated on admin writes.
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { cacheGet, cacheSet, cacheDelPattern } from "@/lib/cache";

const FEE_KEY = "platform_fee_percent";
const CACHE_KEY = "platform:fee_percent";
const TTL_SECONDS = 300;

function envFallback(): number {
  const raw = Number(process.env.PLATFORM_FEE_PERCENT ?? "5");
  return Number.isFinite(raw) && raw >= 0 && raw <= 100 ? raw : 5;
}

/** Platform's default cut of entry fees, in percent. Resolution: admin-set
 *  platform_settings row → PLATFORM_FEE_PERCENT env → 5. Plans and per-org
 *  overrides sit ABOVE this default (see feePercentFor in registrations). */
export async function platformFeeDefault(): Promise<number> {
  const cached = await cacheGet<{ v: number }>(CACHE_KEY);
  if (cached) return cached.v;
  const [row] = await sql<{ value: unknown }[]>`
    select value from platform_settings where key = ${FEE_KEY}`;
  const parsed = Number(row?.value);
  const v = Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : envFallback();
  await cacheSet(CACHE_KEY, { v }, TTL_SECONDS);
  return v;
}

/** Admin write (staff-only route). Bounds-checked; audited via updated_by. */
export async function setPlatformFeeDefault(pct: number, actorId: string): Promise<void> {
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    throw new HttpError(422, "Fee percent must be between 0 and 100");
  }
  await sql`
    insert into platform_settings (key, value, updated_by)
    values (${FEE_KEY}, ${sql.json(pct)}, ${actorId})
    on conflict (key) do update
      set value = excluded.value, updated_at = now(), updated_by = excluded.updated_by`;
  await cacheDelPattern(CACHE_KEY);
}
