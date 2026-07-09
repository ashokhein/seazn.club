// Cookie/analytics consent constants, shared by the client banner and the
// server audit route. No imports so either runtime can use it.

/** localStorage key holding the visitor's analytics choice. */
export const CONSENT_KEY = "seazn_cookie_consent";

/** Custom DOM event that reopens the consent banner (withdraw/change choice). */
export const CONSENT_REOPEN_EVENT = "seazn:cookie-settings";

/**
 * Bump when the cookie policy materially changes — a newer version than the one
 * a visitor consented to should re-prompt them. Keep in sync with the "Last
 * updated" date on /legal/cookie-policy.
 */
export const COOKIE_POLICY_VERSION = "2026-07-09";

export type ConsentChoice = "accepted" | "rejected";
