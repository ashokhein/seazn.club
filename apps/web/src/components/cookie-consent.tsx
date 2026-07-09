"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import posthog from "posthog-js";
import {
  CONSENT_KEY,
  CONSENT_VERSION_KEY,
  CONSENT_REOPEN_EVENT,
  COOKIE_POLICY_VERSION,
  needsConsentPrompt,
  type ConsentChoice,
} from "@/lib/consent";

/**
 * Consent banner. Essential cookies (login) always run; analytics (PostHog) is
 * opt-in per GDPR. "Accept" opts PostHog into capturing; "Reject" keeps it
 * opted out. The choice is remembered so the banner shows once, and can be
 * changed later via a "Cookie settings" control (see CookieSettingsButton),
 * which re-dispatches CONSENT_REOPEN_EVENT to reopen this banner —
 * withdrawal is as easy as granting. instrumentation-client reads the same key
 * on load to decide whether to capture before hydration.
 */
export function CookieConsent() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // Show on first visit, or when the policy version moved on since the
    // visitor last chose (policy change / new third party → re-consent).
    if (needsConsentPrompt()) setVisible(true);
    // Re-open on demand so users can withdraw/change consent at any time.
    const reopen = () => setVisible(true);
    window.addEventListener(CONSENT_REOPEN_EVENT, reopen);
    return () => window.removeEventListener(CONSENT_REOPEN_EVENT, reopen);
  }, []);

  function decide(choice: ConsentChoice) {
    localStorage.setItem(CONSENT_KEY, choice);
    // Stamp the version this choice covers, so a later policy bump re-prompts.
    localStorage.setItem(CONSENT_VERSION_KEY, COOKIE_POLICY_VERSION);
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
    // Server-side proof-of-consent (GDPR). Best-effort — never blocks the UI.
    void fetch("/api/consent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ choice, policy_version: COOKIE_POLICY_VERSION }),
    }).catch(() => {});
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
