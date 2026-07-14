import "server-only";
import { cookies } from "next/headers";
import { getCurrentUser } from "@/lib/auth";
import { pickTimezone, TZ_COOKIE } from "@/lib/tz";

/**
 * Resolve the viewer's timezone for the current request (spec §5.3):
 *   1. users.timezone (signed-in, explicit pick)
 *   2. seazn_tz cookie (browser-detected, so anonymous / not-yet-set users
 *      still resolve to their real zone server-side)
 *   3. 'UTC'
 * Personal-lane renders use this; the venue lane keeps schedule_settings.tz.
 */
export async function resolveTimezone(): Promise<string> {
  const [user, jar] = await Promise.all([getCurrentUser(), cookies()]);
  const cookieTz = jar.get(TZ_COOKIE)?.value ?? null;
  return pickTimezone(user?.timezone ?? null, cookieTz);
}
