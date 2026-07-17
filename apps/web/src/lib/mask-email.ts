/**
 * Partial-mask an email for display when the viewer isn't its owner (e.g.
 * an invite-claim mismatch screen, where both the invited address and the
 * signed-in address belong to someone other than a guaranteed-safe viewer).
 * Uses fixed-width asterisks rather than one-per-character so the mask
 * doesn't leak the address's exact length.
 */
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const maskedLocal = local.length <= 2 ? `${local[0]}*` : `${local[0]}***${local[local.length - 1]}`;
  const lastDot = domain.lastIndexOf(".");
  const maskedDomain = lastDot > 0 ? `${domain[0]}***${domain.slice(lastDot)}` : `${domain[0]}***`;
  return `${maskedLocal}@${maskedDomain}`;
}
