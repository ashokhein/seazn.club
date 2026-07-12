import { afterEach, describe, expect, it, vi } from "vitest";
import { broadcastRevalidate } from "@/lib/peer-revalidate";

afterEach(() => vi.unstubAllEnvs());

function arm() {
  vi.stubEnv("PEER_REVALIDATE", "1");
  vi.stubEnv("FLY_APP_NAME", "seazn-club-prod");
  vi.stubEnv("CRON_SECRET", "s3cret");
  vi.stubEnv("FLY_PRIVATE_IP", "fdaa::3");
}

describe("broadcastRevalidate", () => {
  it("no-ops when PEER_REVALIDATE is not enabled", async () => {
    const fetchFn = vi.fn();
    await broadcastRevalidate(["division:d1"], "swr", { fetchFn });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("POSTs tags to every peer except itself, with the secret header", async () => {
    arm();
    const fetchFn = vi.fn(async () => new Response("{}"));
    await broadcastRevalidate(["division:d1", "competition:c1"], "swr", {
      resolveIps: async () => ["fdaa::3", "fdaa::4", "fdaa::5"],
      fetchFn,
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string>; body: string },
    ];
    expect(String(url)).toBe("http://[fdaa::4]:3000/api/internal/revalidate");
    expect(init.headers["x-cron-secret"]).toBe("s3cret");
    expect(JSON.parse(init.body)).toEqual({ tags: ["division:d1", "competition:c1"], mode: "swr" });
  });

  it("swallows resolver and fetch failures (fail-open)", async () => {
    arm();
    await expect(
      broadcastRevalidate(["division:d1"], "swr", {
        resolveIps: async () => {
          throw new Error("dns down");
        },
      }),
    ).resolves.toBeUndefined();
  });
});
