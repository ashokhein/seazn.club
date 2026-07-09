"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import posthog from "posthog-js";

const KEY = "seazn_cookie_consent";

/**
 * Consent banner. Essential cookies (login) always run; analytics (PostHog) is
 * opt-in per GDPR. "Accept" opts PostHog into capturing; "Reject" keeps it
 * opted out. The choice is remembered so the banner shows once. instrumentation-
 * client reads the same key on load to decide whether to capture before hydration.
 */
export function CookieConsent() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!localStorage.getItem(KEY)) setVisible(true);
  }, []);

  function decide(choice: "accepted" | "rejected") {
    localStorage.setItem(KEY, choice);
    try {
      if (posthog.__loaded) {
        if (choice === "accepted") {
          posthog.opt_in_capturing();
          posthog.capture("$pageview"); // count the current page now that we may
        } else {
          posthog.opt_out_capturing();
        }
      }
    } catch {
      // Never let an analytics hiccup block dismissing the banner.
    }
    setVisible(false);
  }

  if (!visible) return null;

  return (
    <div className="fixed bottom-4 left-4 right-4 z-50 mx-auto max-w-xl rounded-2xl border border-purple-100 bg-white p-4 shadow-xl sm:left-6 sm:right-auto sm:max-w-sm">
      <p className="text-sm text-slate-600">
        We use essential cookies to keep you logged in. With your consent, we
        also use PostHog analytics to understand product usage and improve Seazn
        Club. No advertising cookies.{" "}
        <Link href="/legal/cookie-policy" className="text-purple-600 underline">
          Cookie policy
        </Link>
        .
      </p>
      <div className="mt-3 flex gap-2">
        <button onClick={() => decide("accepted")} className="btn btn-primary text-xs">
          Accept
        </button>
        <button onClick={() => decide("rejected")} className="btn btn-ghost text-xs">
          Reject
        </button>
      </div>
    </div>
  );
}
