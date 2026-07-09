"use client";

import { useEffect, useRef } from "react";
import { track } from "@/lib/analytics";
import type { AnalyticsEvent } from "@/lib/analytics-events";

/**
 * Fires a single analytics event once when mounted — for page-view-style
 * funnel entries on server-rendered pages (e.g. pricing_viewed). Renders null.
 */
export function TrackOnMount({
  event,
  properties,
}: {
  event: AnalyticsEvent;
  properties?: Record<string, unknown>;
}) {
  const fired = useRef(false);
  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    track(event, properties);
  }, [event, properties]);
  return null;
}
