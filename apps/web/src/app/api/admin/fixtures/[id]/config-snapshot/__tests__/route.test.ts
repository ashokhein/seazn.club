// POST /api/admin/fixtures/{id}/config-snapshot — the V347 escape hatch.
//
// WHAT THIS FILE IS FOR, and it is not the happy path. The route's stated bar is
// SUPERADMIN, not staff: the config it discards survives only in the audit row
// the usecase writes, there is no second copy and no undo, so the bar is higher
// than merely reading `/admin/fixtures`. Nothing pinned that. Every other test
// mocks the guard wholesale, so swapping `requireSuperadmin` for `requireStaff`
// stayed green — a silent privilege downgrade with a passing suite.
//
// So this mocks one layer LOWER than the admin-route idiom: `requireUser` and
// `sql` are the doubles, and the real `requireStaff` / `requireSuperadmin` run
// against them. A `support` staff user is the discriminating case — plain staff
// would let them through, superadmin does not.
import { beforeEach, describe, expect, it, vi } from "vitest";

const requireUserMock = vi.fn<() => Promise<{ id: string }>>();
vi.mock("@/lib/auth", () => ({
  requireUser: () => requireUserMock(),
}));

// `requireStaff` reads the caller's row through this; nothing else in the route
// touches the DB, because the usecase is mocked below.
const sqlMock = vi.fn<(...args: unknown[]) => Promise<unknown[]>>();
vi.mock("@/lib/db", () => ({
  sql: (...args: unknown[]) => sqlMock(...args),
}));

const resnapshotMock = vi.fn<(...args: unknown[]) => Promise<void>>();
const panelMock = vi.fn<(...args: unknown[]) => Promise<unknown>>();
vi.mock("@/server/usecases/admin-fixture-config", () => ({
  resnapshotFixtureConfig: (...args: unknown[]) => resnapshotMock(...args),
  fixtureConfigPanel: (...args: unknown[]) => panelMock(...args),
}));

import { POST } from "../route";

const FIXTURE_ID = "11111111-2222-3333-4444-555555555555";

function callerIs(role: "superadmin" | "support" | null, isStaff = role !== null) {
  requireUserMock.mockResolvedValue({ id: "user-1" });
  sqlMock.mockResolvedValue([
    {
      id: "user-1",
      display_name: "Sam",
      email: "sam@example.test",
      avatar_url: null,
      is_staff: isStaff,
      staff_role: role,
    },
  ]);
}

const post = (body: unknown = { reason: "ticket 4412" }) =>
  POST(
    new Request(`http://test/api/admin/fixtures/${FIXTURE_ID}/config-snapshot`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: FIXTURE_ID }) },
  );

beforeEach(() => {
  requireUserMock.mockReset();
  sqlMock.mockReset();
  resnapshotMock.mockReset().mockResolvedValue(undefined);
  panelMock.mockReset().mockResolvedValue({ fixtureId: FIXTURE_ID, diverged: false });
});

describe("POST /api/admin/fixtures/{id}/config-snapshot", () => {
  it("lets a superadmin re-snapshot, and hands the usecase the acting staff id", async () => {
    callerIs("superadmin");
    const res = await post();
    expect(res.status).toBe(200);
    expect(resnapshotMock).toHaveBeenCalledWith("user-1", FIXTURE_ID, "ticket 4412");
  });

  it("refuses a SUPPORT-role staff user — the hatch is superadmin, not staff", async () => {
    // The whole point of the file. `support` passes `requireStaff` and fails
    // `requireSuperadmin`, so this is the one caller whose verdict differs
    // between the two: downgrade the route and this test, alone, goes red.
    callerIs("support");
    const res = await post();
    expect(res.status).toBe(401);
    expect(resnapshotMock).not.toHaveBeenCalled();
    expect(panelMock).not.toHaveBeenCalled();
  });

  it("refuses a staff user with no role at all", async () => {
    callerIs(null, true);
    const res = await post();
    expect(res.status).toBe(401);
    expect(resnapshotMock).not.toHaveBeenCalled();
  });

  it("refuses a signed-in non-staff caller", async () => {
    callerIs(null, false);
    const res = await post();
    expect(res.status).toBe(401);
    expect(resnapshotMock).not.toHaveBeenCalled();
  });

  it("400s an empty reason before the guard's work reaches the usecase", async () => {
    // The audit row is the only record of the discarded config, so a blank
    // reason is refused at the edge as well as in the usecase.
    callerIs("superadmin");
    const res = await post({ reason: "" });
    expect(res.status).toBe(400);
    expect(resnapshotMock).not.toHaveBeenCalled();
  });
});
