"use client";

import { useEffect, useState } from "react";
import posthog from "posthog-js";
import { AnalyticsIdentify } from "@/components/analytics-identify";

interface Identity {
  userId: string;
  orgId: string;
  orgName: string;
  plan: string;
}

interface MeResponse {
  data: {
    id: string;
    org: { id: string; name: string; plan: string } | null;
  };
}

const IDENTITY_CACHE_KEY = "seazn_analytics_identity";

/**
 * Client-mounted (task-8: make the public tree actually ISR in production).
 * The old version was a server component that called getCurrentUser() (->
 * cookies()) directly from the ROOT layout — that forces EVERY route
 * rendered through it (/, /clubs, /people, /players, /_not-found, and would
 * re-dynamicize /shared once R1's generateStaticParams fix landed) to render
 * dynamically the moment NEXT_PUBLIC_POSTHOG_KEY is set (task-7's audited
 * finding). This version resolves the exact same identity
 * (userId/orgId/orgName/plan) via a fetch to GET /api/users/me instead,
 * keeping the root layout's RSC tree cookie-free. Memoized in sessionStorage
 * so a browser tab only pays for the round trip once; a failed/401 fetch
 * (anonymous visitor) leaves identity null and renders nothing, same as the
 * old `if (user && org)` gate. AnalyticsIdentify (the actual
 * posthog.identify/group call) is unchanged.
 */
export function AnalyticsBootstrap() {
  const [identity, setIdentity] = useState<Identity | null>(null);

  useEffect(() => {
    if (!posthog.__loaded) return; // no key configured, or impersonation-suppressed

    const cached = sessionStorage.getItem(IDENTITY_CACHE_KEY);
    if (cached) {
      try {
        setIdentity(JSON.parse(cached) as Identity);
      } catch {
        sessionStorage.removeItem(IDENTITY_CACHE_KEY);
      }
      return;
    }

    let cancelled = false;
    fetch("/api/users/me")
      .then((res) => (res.ok ? (res.json() as Promise<MeResponse>) : null))
      .then((body) => {
        if (cancelled || !body?.data.org) return;
        const next: Identity = {
          userId: body.data.id,
          orgId: body.data.org.id,
          orgName: body.data.org.name,
          plan: body.data.org.plan,
        };
        sessionStorage.setItem(IDENTITY_CACHE_KEY, JSON.stringify(next));
        setIdentity(next);
      })
      .catch(() => {
        // Analytics must never break the app — swallow fetch failures.
      });

    return () => {
      cancelled = true;
    };
  }, []);

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
