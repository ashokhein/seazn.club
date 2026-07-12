import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { purgeCdn, __resetPurgeDebounceForTests } from "@/lib/cdn-purge";

beforeEach(() => __resetPurgeDebounceForTests());
afterEach(() => vi.unstubAllEnvs());

function arm() {
  vi.stubEnv("CDN_PURGE_URL", "https://api.cloudflare.com/client/v4/zones/z1/purge_cache");
  vi.stubEnv("CDN_PURGE_TOKEN", "tok");
}

describe("purgeCdn", () => {
  it("no-ops without CDN env", async () => {
    const fetchFn = vi.fn();
    await purgeCdn({ fetchFn });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("POSTs purge_everything with the bearer token", async () => {
    arm();
    const fetchFn = vi.fn(async () => new Response("{}"));
    await purgeCdn({ fetchFn });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string>; body: string },
    ];
    expect(String(url)).toContain("/purge_cache");
    expect(init.headers.authorization).toBe("Bearer tok");
    expect(JSON.parse(init.body)).toEqual({ purge_everything: true });
  });

  it("debounces to one purge per 30s window", async () => {
    arm();
    const fetchFn = vi.fn(async () => new Response("{}"));
    let t = 1_000_000;
    const now = () => t;
    await purgeCdn({ fetchFn, now });
    await purgeCdn({ fetchFn, now }); // same instant — skipped
    t += 31_000;
    await purgeCdn({ fetchFn, now });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("swallows network failures (fail-open)", async () => {
    arm();
    await expect(
      purgeCdn({ fetchFn: vi.fn(async () => Promise.reject(new Error("down"))) }),
    ).resolves.toBeUndefined();
  });
});
