// #387 — what happens when the TELEMETRY write itself fails.
//
// Separate from `ai-quote-mismatch.test.ts` on purpose: that suite drives the
// three real run paths against real Postgres, where the insert succeeds. The
// failure this file is about cannot be produced there — it needs the write to
// throw, which means mocking `withTenant`, which is incompatible with a suite
// whose other assertions read the rows back.
//
// Why it matters: all three call sites `await recordQuoteMismatch(...)` bare,
// and they sit inside functions whose outer wrapper re-throws once the credit
// is consumed. Before the catch inside the helper, a constraint or
// serialization error on this insert turned a PAID, SUCCESSFUL run into a 500 —
// the organiser lost the response to a plan they had already been charged for,
// caused by the very telemetry that exists to detect them being overcharged.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { withTenantMock } = vi.hoisted(() => ({ withTenantMock: vi.fn() }));
vi.mock("@/lib/db", () => ({ withTenant: withTenantMock }));

import type { AuthCtx } from "@/server/api-v1/auth";
import { recordQuoteMismatch } from "../ai-quote-mismatch";

const auth = { orgId: "org-1", userId: "user-1" } as unknown as AuthCtx;
const ctx = { competitionId: "comp-1", divisionIds: ["div-1", "div-2"] };

describe("recordQuoteMismatch — the write failing must not fail the run", () => {
  beforeEach(() => {
    withTenantMock.mockReset();
    // Default: the write succeeds. Individual tests override.
    withTenantMock.mockResolvedValue(undefined);
  });

  it("still resolves with the mismatch when the insert throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    withTenantMock.mockRejectedValue(new Error("duplicate key value violates unique constraint"));

    // The assertion that carries the regression: without the catch this
    // REJECTS, and the three call sites propagate that to a 500.
    await expect(recordQuoteMismatch(auth, ctx, 7, 9)).resolves.toEqual({
      quoted: 7,
      charged: 9,
    });

    // The failure is not silent — a swallowed telemetry error that leaves no
    // trace is how a permanently broken insert goes unnoticed for a month.
    expect(warn).toHaveBeenCalledWith("[quote-mismatch] record failed:", expect.any(Error));
    warn.mockRestore();
  });

  it("reports the mismatch to the caller even though nothing was recorded", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    withTenantMock.mockRejectedValue(new Error("could not serialize access"));

    // A lost row is not a reason to tell the caller their quote matched. The
    // comparison is pure and was already true before the write was attempted,
    // so the response field stays truthful independently of the database.
    const out = await recordQuoteMismatch(auth, ctx, 12, 4);
    expect(out).toEqual({ quoted: 12, charged: 4 });
    vi.restoreAllMocks();
  });

  it("returns the mismatch when the insert succeeds, and writes exactly once", async () => {
    // Guards the other direction: a catch-all that swallowed everything would
    // pass the two tests above while never writing at all.
    const out = await recordQuoteMismatch(auth, ctx, 3, 5);
    expect(out).toEqual({ quoted: 3, charged: 5 });
    expect(withTenantMock).toHaveBeenCalledTimes(1);
    expect(withTenantMock).toHaveBeenCalledWith("org-1", expect.any(Function));
  });

  it("does not touch the database when the quote matched the charge", async () => {
    await expect(recordQuoteMismatch(auth, ctx, 6, 6)).resolves.toBeUndefined();
    expect(withTenantMock).not.toHaveBeenCalled();
  });

  it("does not touch the database when no quote was sent", async () => {
    // `undefined` is silence, not zero — server-side callers, smoke and every
    // external consumer send nothing.
    await expect(recordQuoteMismatch(auth, ctx, undefined, 5)).resolves.toBeUndefined();
    expect(withTenantMock).not.toHaveBeenCalled();
  });

  it("does not treat a zero charge against a zero quote as a mismatch", async () => {
    // 0 is falsy; a `!quoted` guard instead of `=== undefined` would file a
    // mismatch here and miss the real one below.
    await expect(recordQuoteMismatch(auth, ctx, 0, 0)).resolves.toBeUndefined();
    expect(withTenantMock).not.toHaveBeenCalled();
  });

  it("records a free run that was quoted as costing something", async () => {
    // The other half of the 0 pair: quoted 2, charged 0 IS a mismatch, and the
    // direction is `under`.
    await expect(recordQuoteMismatch(auth, ctx, 2, 0)).resolves.toEqual({
      quoted: 2,
      charged: 0,
    });
    expect(withTenantMock).toHaveBeenCalledTimes(1);
  });
});
