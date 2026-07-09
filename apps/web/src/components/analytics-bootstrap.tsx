import "server-only";
import { getCurrentUser, resolveActiveOrg } from "@/lib/auth";
import { sql } from "@/lib/db";
import { AnalyticsIdentify } from "@/components/analytics-identify";

/**
 * Server component mounted once in the root layout. For logged-in users it
 * resolves the active org + plan and hands them to the client identifier.
 *
 * Cheap for anonymous traffic: getCurrentUser only reads the session cookie
 * (no DB) when it's absent, so marketing pages pay nothing here. Wrapped in a
 * best-effort try/catch — analytics identity must never break page render.
 */
export async function AnalyticsBootstrap() {
  // Skip entirely when PostHog isn't configured.
  if (!process.env.NEXT_PUBLIC_POSTHOG_KEY) return null;

  // Resolve identity defensively — a failure here must not break page render.
  // (JSX is built outside the try/catch: React defers rendering, so catch
  // wouldn't see render-time errors anyway.)
  let identity: { userId: string; orgId: string; orgName: string; plan: string } | null = null;
  try {
    const user = await getCurrentUser();
    const org = user ? await resolveActiveOrg(user) : null;
    if (user && org) {
      const [sub] = await sql<{ plan_key: string | null }[]>`
        select coalesce(plan_key, 'community') as plan_key
        from subscriptions where org_id = ${org.id}`;
      identity = {
        userId: user.id,
        orgId: org.id,
        orgName: org.name,
        plan: sub?.plan_key ?? "community",
      };
    }
  } catch {
    return null;
  }

  if (!identity) return null;
  return (
    <AnalyticsIdentify
      userId={identity.userId}
      orgId={identity.orgId}
      orgName={identity.orgName}
      plan={identity.plan}
    />
  );
}
