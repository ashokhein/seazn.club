import { sql } from "@/lib/db";

/** "Last updated" date of /legal/terms + /legal/privacy — bump when the text
 *  changes. (Cookie-banner consent versioning lives separately in consent.ts.) */
export const LEGAL_VERSION = "2026-07-14";

/**
 * Record clickwrap acceptance of Terms + Privacy (GDPR spec 2026-07-14): the
 * user acted under a "By continuing, you agree…" notice. First acceptance
 * wins — later logins must not move the timestamp.
 */
export async function stampTermsAcceptance(userId: string): Promise<void> {
  await sql`
    update users set
      terms_accepted_at = coalesce(terms_accepted_at, now()),
      terms_version     = coalesce(terms_version, ${LEGAL_VERSION})
    where id = ${userId}`;
}
