"use client";

import { useEffect } from "react";
import posthog from "posthog-js";
import { ORG_GROUP } from "@/lib/analytics-events";

interface Props {
  userId: string;
  orgId: string;
  orgName: string;
  plan: string;
}

/**
 * Ties the anonymous PostHog session to the logged-in user and their active
 * org. `group()` powers per-club (group) analytics in our multi-tenant model;
 * `plan` on the group lets revenue funnels segment by tier. Renders nothing.
 */
export function AnalyticsIdentify({ userId, orgId, orgName, plan }: Props) {
  useEffect(() => {
    if (!posthog.__loaded) return;
    // Avoid re-identifying on every render/nav once we're on the right person.
    if (posthog.get_distinct_id() !== userId) {
      posthog.identify(userId);
    }
    posthog.group(ORG_GROUP, orgId, { name: orgName, plan });
  }, [userId, orgId, orgName, plan]);

  return null;
}
