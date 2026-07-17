"use client";

// App-wide route error boundary (observability): any render error under the
// root layout degrades to this instead of Next's bare "Application error"
// message (which is all prod shows once React redacts the real error). We
// report to Sentry here and offer a retry — `reset()` re-renders the failed
// segment. Copy is hardcoded English on purpose: this must render even when
// the thing that failed is the i18n/dictionary provider itself.
import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <main className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center gap-4 px-4 text-center">
      <h1 className="text-lg font-semibold text-slate-800">Something went wrong</h1>
      <p className="text-sm text-slate-500">
        This page hit an unexpected error. Try again — if it keeps happening,
        the team has been notified.
      </p>
      {error.digest && (
        <p className="text-xs text-slate-400">Reference: {error.digest}</p>
      )}
      <button type="button" onClick={reset} className="btn btn-primary">
        Try again
      </button>
    </main>
  );
}
