import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { AuthError, HttpError, PaymentRequiredError } from "@/lib/errors";
import { featureReason } from "@/lib/feature-copy";
import * as Sentry from "@sentry/nextjs";

export { HttpError, PaymentRequiredError } from "@/lib/errors";

/** Wraps a route handler with consistent JSON error handling. */
export function handler<T>(fn: () => Promise<T>) {
  return fn()
    .then((data) => NextResponse.json({ ok: true, data }))
    .catch((err: unknown) => {
      if (err instanceof ZodError) {
        return NextResponse.json(
          { ok: false, error: "Invalid input", issues: err.issues },
          { status: 400 },
        );
      }
      if (err instanceof AuthError) {
        return NextResponse.json(
          { ok: false, error: err.message },
          { status: 401 },
        );
      }
      if (err instanceof PaymentRequiredError) {
        // Upgrade-moment contract (doc 10 §3): feature_key + human reason
        // let the client render a contextual paywall (<UpgradeGate>).
        return NextResponse.json(
          {
            ok: false,
            error: err.message,
            feature_key: err.featureKey,
            reason: featureReason(err.featureKey),
          },
          { status: 402 },
        );
      }
      if (err instanceof HttpError) {
        // 4xx are expected; only capture 5xx
        if (err.status >= 500) Sentry.captureException(err);
        return NextResponse.json(
          { ok: false, error: err.message },
          { status: err.status },
        );
      }
      // Unexpected error — always capture
      Sentry.captureException(err);
      const message = err instanceof Error ? err.message : "Server error";
      return NextResponse.json({ ok: false, error: message }, { status: 500 });
    });
}
