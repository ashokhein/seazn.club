// Cookie/analytics consent constants, shared by the client banner and the
// server audit route. No imports so either runtime can use it.

/** localStorage key holding the visitor's analytics choice ("accepted"/"rejected"). */
export const CONSENT_KEY = "seazn_cookie_consent";

/** localStorage key holding the policy version the choice was made against.
 *  A mismatch with COOKIE_POLICY_VERSION means the terms changed → re-prompt. */
export const CONSENT_VERSION_KEY = "seazn_cookie_consent_version";

/** Custom DOM event that reopens the consent banner (withdraw/change choice). */
export const CONSENT_REOPEN_EVENT = "seazn:cookie-settings";

/**
 * Bump when the cookie policy materially changes or a new third party is added.
 * A visitor whose stored consent version differs is re-prompted (their old
 * choice no longer covers the new terms). Keep in sync with the "Last updated"
 * date on /legal/cookie-policy.
 */
export const COOKIE_POLICY_VERSION = "2026-07-09";

export type ConsentChoice = "accepted" | "rejected";

/**
 * True when the stored choice still covers the CURRENT policy version — i.e.
 * the visitor accepted AND the terms haven't changed since. Shared by the
 * banner (whether to show) and instrumentation-client (whether to capture).
 * Safe on the server (returns false when there's no localStorage).
 */
export function analyticsConsented(): boolean {
  try {
    return (
      localStorage.getItem(CONSENT_KEY) === "accepted" &&
      localStorage.getItem(CONSENT_VERSION_KEY) === COOKIE_POLICY_VERSION
    );
  } catch {
    return false;
  }
}

/** True when the banner should be shown: no choice yet, or the policy version
 *  moved on since the visitor last chose. */
export function needsConsentPrompt(): boolean {
  try {
    return (
      !localStorage.getItem(CONSENT_KEY) ||
      localStorage.getItem(CONSENT_VERSION_KEY) !== COOKIE_POLICY_VERSION
    );
  } catch {
    return false;
  }
}
