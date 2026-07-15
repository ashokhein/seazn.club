// Per-registrant email locale capture (v5 i18n cycle 47, Deliverable B). Pure so
// it is unit-testable off the DB: submitRegistration resolves the value here and
// stores it on the row; every registrant-facing sender then reads it.
import { hasLocale, toLocale, type Locale } from "@/lib/i18n-constants";

/**
 * The locale to freeze on a new registration:
 *   1. the registrant's explicit switcher pick (seazn_locale cookie), if valid
 *   2. the organiser's public default (organizations.default_locale)
 *   3. English
 * Frozen at signup so the confirmation/payment/refund/dispute mail matches the
 * language the registrant actually filled the form in.
 */
export function captureRegistrantLocale(
  explicit: string | null | undefined,
  orgDefault: string | null | undefined,
): Locale {
  if (explicit != null && hasLocale(explicit)) return explicit;
  return toLocale(orgDefault);
}
