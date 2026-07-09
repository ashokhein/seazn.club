import { z } from "zod";
import { handler } from "@/lib/http";
import { sql } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { COOKIE_POLICY_VERSION } from "@/lib/consent";

const Body = z.object({
  choice: z.enum(["accepted", "rejected"]),
  policy_version: z.string().max(40).default(COOKIE_POLICY_VERSION),
});

/** First client IP from the proxy chain, validated so a spoofed/garbage header
 *  can't error the `inet` insert. Returns null when nothing usable is present. */
function clientIp(req: Request): string | null {
  const raw =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip")?.trim() ??
    "";
  // Basic IPv4/IPv6 shape check — Postgres `inet` rejects anything else.
  const ok = /^[0-9.]+$/.test(raw) || /^[0-9a-fA-F:]+$/.test(raw);
  return ok && raw ? raw : null;
}

/** POST /api/consent — record a cookie/analytics consent decision (GDPR
 *  proof-of-consent): who, what choice, which policy version, when, from where.
 *  Works logged-in or out; the banner calls it best-effort. */
export async function POST(req: Request) {
  return handler(async () => {
    const { choice, policy_version } = Body.parse(await req.json());
    const user = await getCurrentUser();
    const ua = req.headers.get("user-agent")?.slice(0, 500) ?? null;
    const ip = clientIp(req);
    await sql`
      insert into cookie_consents (user_id, choice, policy_version, user_agent, ip_address)
      values (${user?.id ?? null}, ${choice}, ${policy_version}, ${ua}, ${ip})`;
    return { recorded: true };
  });
}
