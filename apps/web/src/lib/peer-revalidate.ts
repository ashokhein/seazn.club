import "server-only";

// Fan revalidateTag out to sibling Fly machines (spec 2026-07-12 §3 A-step 5).
// Fly's 6PN DNS: `global.<app>.internal` AAAA-resolves to every machine's
// private IPv6. Fail-open by design: a lost broadcast is bounded by the 30s
// public ISR window (REVALIDATE_FAST). This module is the transport seam —
// a Cloud Run move swaps DNS fan-out for Redis pub/sub here, nothing else.
export interface BroadcastDeps {
  resolveIps?: () => Promise<string[]>;
  fetchFn?: typeof fetch;
}

async function flyPeerIps(appName: string): Promise<string[]> {
  const { resolve6 } = await import("node:dns/promises");
  return resolve6(`global.${appName}.internal`);
}

export async function broadcastRevalidate(
  tags: string[],
  mode: "swr" | "expire",
  deps: BroadcastDeps = {},
): Promise<void> {
  const appName = process.env.FLY_APP_NAME;
  const secret = process.env.CRON_SECRET;
  if (process.env.PEER_REVALIDATE !== "1" || !appName || !secret || tags.length === 0) return;
  try {
    const ips = await (deps.resolveIps ?? (() => flyPeerIps(appName)))();
    const self = process.env.FLY_PRIVATE_IP;
    const fetchFn = deps.fetchFn ?? fetch;
    await Promise.allSettled(
      ips
        .filter((ip) => ip !== self)
        .map((ip) =>
          fetchFn(`http://[${ip}]:3000/api/internal/revalidate`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-cron-secret": secret },
            body: JSON.stringify({ tags, mode }),
            signal: AbortSignal.timeout(2000),
          }),
        ),
    );
  } catch {
    // fail open — peers converge within REVALIDATE_FAST
  }
}
