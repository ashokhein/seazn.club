"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import posthog from "posthog-js";
import { AnalyticsIdentify } from "@/components/analytics-identify";
import {
  hasIdentifiedThisTab,
  markIdentifiedThisTab,
  resolveIdentity,
  type AnalyticsIdentity,
} from "@/lib/analytics-identity";

/**
 * Client-mounted (task-8: make the public tree actually ISR in production).
 * The old version was a server component that called getCurrentUser() (->
 * cookies()) directly from the ROOT layout — that forces EVERY route rendered
 * through it to render dynamically the moment NEXT_PUBLIC_POSTHOG_KEY is set
 * (task-7's audited finding). This version resolves the same identity
 * (userId/orgId/orgName/plan) via lib/analytics-identity (a fetch to
 * GET /api/users/me, sessionStorage-memoized) instead, keeping the root
 * layout's RSC tree cookie-free. AnalyticsIdentify (the actual
 * posthog.identify/group call) is unchanged.
 *
 * Lifecycle (task-8 review fix, Critical finding): the effect is keyed on the
 * pathname, not run-once — logins here are SOFT navigations (magic-link.tsx
 * does router.push + refresh), so an empty-dep effect would never identify a
 * user who signed in after first paint. Conversely, logout-button calls
 * clearAnalyticsIdentity() + posthog.reset() before ITS soft navigation,
 * resetting the identified-this-tab flag and the cache, so this effect
 * re-resolves (and 401s → stays anonymous) instead of carrying a stale
 * identity into the next session.
 */
export function AnalyticsBootstrap() {
  // seq bumps per fresh resolution so AnalyticsIdentify REMOUNTS (key below)
  // even when the payload values are identical — e.g. the same user logging
  // back in after a logout: posthog.reset() rotated the distinct id, but
  // AnalyticsIdentify's primitive effect deps wouldn't change, so without the
  // remount it would never re-identify.
  const [resolved, setResolved] = useState<{
    identity: AnalyticsIdentity;
    seq: number;
  } | null>(null);
  const pathname = usePathname();

  // Effect-only on purpose (SSR-safe: the server render and the first client
  // paint both yield null; sessionStorage/fetch happen strictly post-mount) —
  // the react-hooks/set-state-in-effect warning on this pattern remains a
  // deliberate, accepted exception (task-8 report, Concern 2).
  useEffect(() => {
    if (!posthog.__loaded) return; // no key configured, or impersonation-suppressed
    if (hasIdentifiedThisTab()) return; // done this tab — until a logout clears the flag

    // Anonymous-visitor cost trade (task-8 review F2): anonymous results are
    // never cached (a sentinel would block identify-after-login), so an anon
    // visitor pays at most ONE light fetch per soft navigation + one per hard
    // load — and /api/users/me 401s via requireUser() before any DB call when
    // there's no session cookie. Comparable to the old per-request RSC
    // getCurrentUser() cost. Identified visitors pay one fetch per tab, then
    // the flag above short-circuits every later navigation.
    let cancelled = false;
    resolveIdentity()
      .then((identity) => {
        if (cancelled || !identity) return;
        markIdentifiedThisTab();
        setResolved((prev) => ({ identity, seq: (prev?.seq ?? 0) + 1 }));
      })
      .catch(() => {
        // resolveIdentity is total; belt-and-braces — analytics must never
        // break the app.
      });
    return () => {
      cancelled = true;
    };
  }, [pathname]);

  if (!resolved) return null;
  return (
    <AnalyticsIdentify
      key={resolved.seq}
      userId={resolved.identity.userId}
      orgId={resolved.identity.orgId}
      orgName={resolved.identity.orgName}
      plan={resolved.identity.plan}
    />
  );
}
