// Client-side analytics helper. Import ONLY from client components — it pulls
// in posthog-js, which no-ops without a browser window but shouldn't be dragged
// into server bundles. Event names live in analytics-events (server-safe).
import posthog from "posthog-js";
import { EVENTS, type AnalyticsEvent } from "@/lib/analytics-events";

export { EVENTS };

/**
 * Capture a product event from the browser. Safe to call unconditionally: it
 * no-ops when PostHog isn't loaded (no key, SSR, or impersonation-suppressed).
 */
export function track(
  event: AnalyticsEvent,
  properties?: Record<string, unknown>,
): void {
  if (typeof window === "undefined") return;
  if (!posthog.__loaded) return;
  posthog.capture(event, properties);
}
