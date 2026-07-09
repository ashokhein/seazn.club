import { describe, expect, it } from "vitest";
import { posthogIngestHosts } from "../posthog-proxy.mjs";

// The /ingest reverse-proxy destinations (next.config rewrites) must follow the
// PostHog region so EU projects don't silently ship events to US.
describe("posthogIngestHosts", () => {
  it("maps the EU dashboard host onto EU ingest + assets", () => {
    expect(
      posthogIngestHosts({ NEXT_PUBLIC_POSTHOG_HOST: "https://eu.posthog.com" }),
    ).toEqual({
      ingest: "https://eu.i.posthog.com",
      assets: "https://eu-assets.i.posthog.com",
    });
  });

  it("maps the US dashboard host onto US ingest + assets", () => {
    expect(
      posthogIngestHosts({ NEXT_PUBLIC_POSTHOG_HOST: "https://us.posthog.com" }),
    ).toEqual({
      ingest: "https://us.i.posthog.com",
      assets: "https://us-assets.i.posthog.com",
    });
  });

  it("defaults to US when the host is unset", () => {
    expect(posthogIngestHosts({})).toEqual({
      ingest: "https://us.i.posthog.com",
      assets: "https://us-assets.i.posthog.com",
    });
  });

  it("falls back to US for legacy/self-host hostnames", () => {
    expect(
      posthogIngestHosts({ NEXT_PUBLIC_POSTHOG_HOST: "https://app.posthog.com" }),
    ).toEqual({
      ingest: "https://us.i.posthog.com",
      assets: "https://us-assets.i.posthog.com",
    });
  });

  it("keeps US default on a malformed host", () => {
    expect(
      posthogIngestHosts({ NEXT_PUBLIC_POSTHOG_HOST: "not a url" }),
    ).toEqual({
      ingest: "https://us.i.posthog.com",
      assets: "https://us-assets.i.posthog.com",
    });
  });
});
