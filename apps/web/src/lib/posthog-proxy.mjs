// Resolve the PostHog reverse-proxy targets (see next.config rewrites) from the
// environment instead of hardcoding a region. Single source of truth is the
// public dashboard host NEXT_PUBLIC_POSTHOG_HOST: PostHog Cloud's dashboard,
// event-ingest, and static-asset hosts share a region prefix
//   dashboard  eu.posthog.com   /  us.posthog.com
//   ingest     eu.i.posthog.com /  us.i.posthog.com
//   assets     eu-assets.i.posthog.com / us-assets.i.posthog.com
// so we map the dashboard host's region onto the ingest + assets hosts.

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ ingest: string, assets: string }}
 */
export function posthogIngestHosts(env = process.env) {
  const ui = env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.posthog.com";
  let region = "us";
  try {
    // Only PostHog Cloud EU gets the `eu` region; anything else (US cloud,
    // legacy app.posthog.com, self-host) falls back to US ingest.
    if (new URL(ui).hostname.split(".")[0] === "eu") region = "eu";
  } catch {
    // Malformed host → keep US default.
  }
  return {
    ingest: `https://${region}.i.posthog.com`,
    assets: `https://${region}-assets.i.posthog.com`,
  };
}
