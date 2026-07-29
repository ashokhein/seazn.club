// Cron route for the daily billing reconciliation: same x-cron-secret /
// CRON_SECRET contract as /api/cron/billing-events. next/headers is mocked so
// the route runs without a request scope, and the three usecases are mocked so
// this stays DB-free and Stripe-free — their logic is covered in their own
// suites (billing-groups, billing-events-sweep, org-addon-price-sweep).
//
// The third assertion is the point of this file. #332's sweep shipped with NO
// CALLER: the function existed, was tested, and could never run in production.
// A backstop nothing invokes is indistinguishable from an absent backstop, and
// nothing in the sweep's own suite could notice. This is the test that fails if
// it is ever unwired again.
import { afterEach, describe, expect, it, vi } from "vitest";

const hdrs = vi.hoisted(() => ({ store: new Headers() }));
vi.mock("next/headers", () => ({ headers: async () => hdrs.store }));

const mocks = vi.hoisted(() => ({
  reconcile: vi.fn(),
  orphans: vi.fn(),
  addonPrices: vi.fn(),
  orphanGroups: vi.fn(),
}));
vi.mock("@/server/usecases/billing-groups", () => ({
  reconcileGroupQuantities: mocks.reconcile,
  countOrgsWithoutGroup: mocks.orphans,
  sweepOrphanGroups: mocks.orphanGroups,
}));
vi.mock("@/server/usecases/billing-events", () => ({
  sweepStaleOrgAddonPrices: mocks.addonPrices,
}));

import { POST } from "./route";

afterEach(() => {
  vi.unstubAllEnvs();
  hdrs.store = new Headers();
  for (const m of Object.values(mocks)) m.mockReset();
});

const authorize = () => {
  vi.stubEnv("CRON_SECRET", "s3cret");
  hdrs.store = new Headers({ "x-cron-secret": "s3cret" });
  mocks.reconcile.mockResolvedValue({ checked: 3, corrected: 1 });
  mocks.orphans.mockResolvedValue(0);
  mocks.orphanGroups.mockResolvedValue({ checked: 2, retired: 1, stillLive: 0, failed: 0 });
  mocks.addonPrices.mockResolvedValue({
    total: 2,
    checked: 2,
    mismatched: 0,
    unresolved: 0,
    vanished: 0,
    unreadable: 0,
    alerted: 0,
    mismatches: [],
  });
};

describe("POST /api/cron/billing-quantity", () => {
  it("401s on a missing or wrong x-cron-secret, running nothing", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    expect((await POST()).status).toBe(401); // no header at all
    hdrs.store = new Headers({ "x-cron-secret": "wrong" });
    expect((await POST()).status).toBe(401);
    // Asserted for all three, not just the first: an unauthenticated caller
    // must not be able to make the platform spend Stripe reads either.
    for (const m of Object.values(mocks)) expect(m).not.toHaveBeenCalled();
  });

  it("503s when CRON_SECRET is not configured", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect((await POST()).status).toBe(503);
  });

  it("REGRESSION (#332): runs the stale-price sweep and returns its counts", async () => {
    authorize();
    const res = await POST();
    expect(res.status).toBe(200);
    expect(mocks.addonPrices).toHaveBeenCalledTimes(1);
    const body = (await res.json()) as { data: { addonPrices?: { checked: number } } };
    // Present in the RESPONSE, not merely invoked: whoever reads this schedule's
    // output is the only audience the sweep has, so a run whose result is
    // dropped on the floor is the same as no run.
    expect(body.data.addonPrices?.checked).toBe(2);
  });

  it("still reports the quantity reconcile and the orphan-org guard alongside it", async () => {
    authorize();
    const body = (await (await POST()).json()) as {
      data: { checked: number; corrected: number; orphanOrgs: number };
    };
    expect(body.data).toMatchObject({ checked: 3, corrected: 1, orphanOrgs: 0 });
    expect(mocks.reconcile).toHaveBeenCalledTimes(1);
    expect(mocks.orphans).toHaveBeenCalledTimes(1);
  });

  it("runs the org-less GROUP sweep and reports it (#375)", async () => {
    // Same reasoning as the #332 assertion above, on the mirror-image guard: an
    // org with no group vs a GROUP with no orgs. `stillLive` is the field an
    // operator acts on — a subscription alive at Stripe with nobody on the bill
    // — so a run whose counts never reach the response is the same as no run.
    authorize();
    const body = (await (await POST()).json()) as {
      data: { orphanGroups?: { checked: number; retired: number; stillLive: number } };
    };
    expect(mocks.orphanGroups).toHaveBeenCalledTimes(1);
    expect(body.data.orphanGroups).toMatchObject({ checked: 2, retired: 1, stillLive: 0 });
  });
});
