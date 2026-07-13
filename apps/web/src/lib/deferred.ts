import "server-only";
import { after } from "next/server";

/**
 * Register non-critical tail work. Registration itself never delays the
 * caller: in a Next request scope, `after()` receives the real work promise
 * and awaits it in its after-window (so it genuinely finishes before the
 * window closes, even on error/redirect/notFound); outside a request scope
 * (vitest, scripts) it falls back to inline fire-and-forget. Either way the
 * work's own errors are swallowed, not thrown — same contract as
 * fire*Revalidate's try/catch.
 */
export function deferred(fn: () => Promise<unknown> | unknown): void {
  const run = async () => {
    try {
      await fn();
    } catch (err) {
      console.warn("[deferred] task failed:", err);
    }
  };
  try {
    after(run);
  } catch {
    void run(); // outside a request scope
  }
}
