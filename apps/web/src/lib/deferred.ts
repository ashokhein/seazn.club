import "server-only";
import { after } from "next/server";

/**
 * Run non-critical tail work AFTER the response streams (Next `after()`),
 * falling back to inline fire-and-forget outside a request scope (vitest,
 * scripts) — same contract as fire*Revalidate's try/catch. Never throws,
 * never delays the caller.
 */
export function deferred(fn: () => Promise<unknown> | unknown): void {
  const run = () => {
    try {
      void Promise.resolve(fn()).catch((err) => console.warn("[deferred] task failed:", err));
    } catch (err) {
      console.warn("[deferred] task failed:", err);
    }
  };
  try {
    after(run);
  } catch {
    run(); // outside a request scope
  }
}
