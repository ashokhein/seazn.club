import "server-only";

// CDN purge hook (spec 2026-07-12 §3 A-step 1). Fail-open + debounced
// purge_everything: at this site's size a full purge every ≤30s window is
// cheaper-simpler than tag→URL mapping, and CDN staleness stays bounded by
// s-maxage even when a purge is missed. Targeted per-URL purge is a later
// refinement at this same seam. Multi-machine: each machine debounces
// independently — worst case N purges per window, still idempotent.
const PURGE_DEBOUNCE_MS = 30_000;
let lastPurgeAt = 0;

export function __resetPurgeDebounceForTests(): void {
  lastPurgeAt = 0;
}

export async function purgeCdn(
  deps: { fetchFn?: typeof fetch; now?: () => number } = {},
): Promise<void> {
  const url = process.env.CDN_PURGE_URL;
  const token = process.env.CDN_PURGE_TOKEN;
  if (!url || !token) return;
  const now = deps.now ?? Date.now;
  if (now() - lastPurgeAt < PURGE_DEBOUNCE_MS) return;
  lastPurgeAt = now();
  try {
    await (deps.fetchFn ?? fetch)(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ purge_everything: true }),
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    // fail open — s-maxage bounds staleness
  }
}
