// Client-side instrumentation (Next 16 file convention): runs after the HTML
// loads and before React hydration — the right place to boot analytics so
// early pageviews are captured. Kept lightweight per the Next docs (<16ms).
import posthog from "posthog-js";
import * as Sentry from "@sentry/nextjs";

// Sentry treats instrumentation-client as the client instrumentation entry once
// it exists (it's injected alongside sentry.client.config, which still runs
// Sentry.init). Re-export its router hook here so SPA navigation tracing keeps
// working — without this, Sentry logs an ACTION REQUIRED at build.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;

const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;

// Staff impersonation swaps the session cookie wholesale (admin/impersonate),
// so the impersonator is indistinguishable from the target user. The
// impersonate route drops a readable `seazn_no_analytics` cookie; honor it by
// not booting PostHog at all, so impersonated sessions never pollute real data.
function analyticsSuppressed(): boolean {
  return document.cookie.split("; ").some((c) => c.startsWith("seazn_no_analytics="));
}

// GDPR: analytics is a non-essential third-party cookie, so it may only capture
// after explicit opt-in. The cookie banner (components/cookie-consent) writes
// this localStorage key; PostHog stays opted-out until it reads "accepted".
function consentGranted(): boolean {
  try {
    return localStorage.getItem("seazn_cookie_consent") === "accepted";
  } catch {
    return false;
  }
}

if (key && !analyticsSuppressed()) {
  try {
    posthog.init(key, {
      // Reverse-proxy through our own origin (next.config rewrites) so
      // ad-blockers don't drop events. ui_host keeps in-app links pointed at
      // the real PostHog dashboard.
      api_host: "/ingest",
      ui_host: process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.posthog.com",
      // Only create person profiles for identified (logged-in) users; anonymous
      // marketing traffic still counts toward web analytics (feature 7) without
      // spending an event allowance on a profile. GDPR-friendlier too.
      person_profiles: "identified_only",
      // Feature 7 — web analytics: capture SPA route changes, not just first load.
      capture_pageview: "history_change",
      capture_pageleave: true,
      // No cookies set and nothing captured until the visitor opts in via the
      // banner. opt_in_capturing() (in cookie-consent) flips this on.
      opt_out_capturing_by_default: true,
      opt_out_persistence_by_default: true,
    });
    if (consentGranted()) posthog.opt_in_capturing();
  } catch {
    // Analytics must never break the app — swallow init failures.
  }
}
