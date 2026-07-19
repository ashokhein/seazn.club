// Cron route auth for the stuck-webhook sweep (P1-7): same x-cron-secret /
// CRON_SECRET contract as /api/cron/registrations. next/headers is mocked so the
// route can be exercised without a request scope, and the sweep is mocked so
// the route test stays DB-free (the sweep logic is covered in
// billing-events-sweep.test.ts).
import { afterEach, describe, expect, it, vi } from "vitest";

const hdrs = vi.hoisted(() => ({ store: new Headers() }));
vi.mock("next/headers", () => ({ headers: async () => hdrs.store }));

const sweepMock = vi.hoisted(() => vi.fn());
vi.mock("@/server/usecases/billing-events", () => ({ sweepStuckEvents: sweepMock }));

import { POST } from "./route";

afterEach(() => {
  vi.unstubAllEnvs();
  hdrs.store = new Headers();
  sweepMock.mockReset();
});

describe("POST /api/cron/billing-events", () => {
  it("401s with a missing or wrong x-cron-secret, never running the sweep", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    expect((await POST()).status).toBe(401); // no header
    hdrs.store = new Headers({ "x-cron-secret": "wrong" });
    expect((await POST()).status).toBe(401);
    expect(sweepMock).not.toHaveBeenCalled();
  });

  it("503s when CRON_SECRET is not configured", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect((await POST()).status).toBe(503);
  });

  it("runs the sweep and returns its counts with the right secret", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    hdrs.store = new Headers({ "x-cron-secret": "s3cret" });
    sweepMock.mockResolvedValue({ replayed: 2, failed: 1, alerted: 0 });
    const res = await POST();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: { replayed: 2, failed: 1, alerted: 0 } });
    expect(sweepMock).toHaveBeenCalledTimes(1);
  });
});
