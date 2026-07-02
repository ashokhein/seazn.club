import "server-only";
import * as Sentry from "@sentry/nextjs";

/**
 * Capture a server-side error with request context.
 * Strips PII — only org_id and user_id are attached (no email, no names).
 */
export function captureError(
  err: unknown,
  context?: {
    userId?: string;
    orgId?: string;
    route?: string;
    extra?: Record<string, unknown>;
  },
): void {
  Sentry.withScope((scope) => {
    if (context?.userId) scope.setUser({ id: context.userId });
    if (context?.orgId) scope.setTag("org_id", context.orgId);
    if (context?.route) scope.setTag("route", context.route);
    if (context?.extra) scope.setExtras(context.extra);
    Sentry.captureException(err);
  });
}
