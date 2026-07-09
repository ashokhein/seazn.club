import "server-only";
import { PostHog } from "posthog-node";
import { ORG_GROUP, type AnalyticsEvent } from "@/lib/analytics-events";

// Server-side PostHog. Backend capture is the reliable path for revenue and
// activation events (feature 1/2) — it doesn't depend on the browser staying
// open or an ad-blocker letting the request through — and it's where server
// feature flags (feature 3) are evaluated. Mirrors lib/sentry's no-key no-op.

// Server key falls back to the public project key (phc_…), which is what
// posthog-node authenticates with. A separate POSTHOG_KEY lets prod diverge.
const KEY = process.env.POSTHOG_KEY ?? process.env.NEXT_PUBLIC_POSTHOG_KEY;
const HOST = process.env.POSTHOG_HOST ?? "https://us.i.posthog.com";

let client: PostHog | null = null;

function getClient(): PostHog | null {
  if (!KEY) return null;
  if (!client) {
    // flushAt:1 / flushInterval:0 → send immediately. Server invocations are
    // short-lived, so we can't rely on a background flush timer.
    client = new PostHog(KEY, { host: HOST, flushAt: 1, flushInterval: 0 });
  }
  return client;
}

export interface CaptureArgs {
  event: AnalyticsEvent;
  /** Stable person id — the user id. Use an `org:<id>` synthetic id only when
   *  no user is in scope (e.g. some webhook paths). */
  distinctId: string;
  /** Attaches the event to the org's group so per-club funnels work. */
  orgId?: string;
  properties?: Record<string, unknown>;
}

/**
 * Capture a server-side event and flush it. No-ops (and never throws) when
 * PostHog isn't configured, so call sites stay unconditional.
 */
export async function captureServer(args: CaptureArgs): Promise<void> {
  const c = getClient();
  if (!c) return;
  try {
    c.capture({
      distinctId: args.distinctId,
      event: args.event,
      properties: args.properties,
      groups: args.orgId ? { [ORG_GROUP]: args.orgId } : undefined,
    });
    await c.flush();
  } catch {
    // Analytics is best-effort — never fail the request it rides on.
  }
}

/**
 * Feature 3 — server-evaluated feature flag. Returns `fallback` (default false)
 * when PostHog is unconfigured or the lookup fails, so gated code degrades to a
 * known state. Pass `orgId` to evaluate group-targeted flags for the club.
 *
 * NOTE: this is for staged rollout / experiments — NOT billing. Paid-tier gates
 * stay in lib/entitlements (plan_entitlements), which is the source of truth.
 */
export async function isServerFeatureEnabled(
  flag: string,
  distinctId: string,
  opts?: { orgId?: string; fallback?: boolean },
): Promise<boolean> {
  const c = getClient();
  if (!c) return opts?.fallback ?? false;
  try {
    const groups = opts?.orgId ? { [ORG_GROUP]: opts.orgId } : undefined;
    const enabled = await c.isFeatureEnabled(flag, distinctId, { groups });
    return enabled ?? opts?.fallback ?? false;
  } catch {
    return opts?.fallback ?? false;
  }
}
