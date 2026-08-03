// v1 kernel: envelope, EngineError→HTTP map, cursor pagination (doc 08 §1/§4).
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { EngineError, EngineErrorCode } from "@seazn/engine/core";
import { AuthError, HttpError, PaymentRequiredError } from "@/lib/errors";
import {
  ENGINE_HTTP,
  v1,
  reply,
  parseBody,
  encodeCursor,
  decodeCursor,
  listQuery,
  page,
} from "../http";

// Only `captureException` is used by the kernel; the spy is what proves a 422
// does not page anyone.
const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock("@sentry/nextjs", () => sentry);

async function body(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

describe("v1 envelope", () => {
  it("wraps success as { ok, data, requestId }", async () => {
    const res = await v1(async () => ({ hello: "world" }));
    expect(res.status).toBe(200);
    const json = await body(res);
    expect(json.ok).toBe(true);
    expect(json.data).toEqual({ hello: "world" });
    expect(typeof json.requestId).toBe("string");
  });

  it("honours reply() status and headers", async () => {
    const res = await v1(async () => reply(201, { id: 1 }, { ETag: '"seq-3"' }));
    expect(res.status).toBe(201);
    expect(res.headers.get("etag")).toBe('"seq-3"');
  });

  // spec 03 §7 / doc 08 §4 — the central code→HTTP map.
  it.each([
    ["SEQ_CONFLICT", 409],
    ["INVALID_EVENT", 422],
    ["LINEUP_INVALID", 422],
    ["ELIGIBILITY", 422],
    ["ALREADY_DECIDED", 422],
    ["STAGE_NOT_READY", 422],
    ["CONFIG_INVALID", 422],
    // W4a (#425) §7 — the core time model's four codes, all 422. UNKNOWN_PHASE
    // was a 500 on the reasoning that a phase order is an internal invariant no
    // client can reach. It is not: `at.period` is a free string on the payload,
    // so an unrecognised period is reachable from any pad that sends one, and a
    // 500 answers it by paging the on-call with nothing the scorer can act on.
    // The write gate rejects a client's unknown period as INVALID_EVENT first
    // (core/events.ts); what is left here is a module whose declared order and
    // whose `apply()` order disagree — still a rejected event, still not a page.
    ["NON_MONOTONIC_TIME", 422],
    ["EXPEDITE_WRONG_WINNER", 422],
    ["SUB_WINDOW_EXCEEDED", 422],
    ["UNKNOWN_PHASE", 422],
  ] as const)("maps EngineError %s → %d", async (code, status) => {
    const res = await v1(async () => {
      throw new EngineError(code, "boom");
    });
    expect(res.status).toBe(status);
    const json = await body(res);
    expect(json.ok).toBe(false);
    expect((json.error as { code: string }).code).toBe(code);
  });

  // The `?? 422` fallback in v1Inner means a code missing from ENGINE_HTTP
  // still answers 200-something plausible, so nothing at runtime notices the
  // omission — and the exhaustive Record only fails `tsc`, which is PR-only
  // for this workspace. Assert the map covers the enum here too.
  it("maps EVERY EngineErrorCode explicitly — no code rides the ?? 422 fallback", () => {
    const unmapped = EngineErrorCode.options.filter((code) => ENGINE_HTTP[code] === undefined);
    expect(unmapped).toEqual([]);
  });

  // W4a (#425) — the reason UNKNOWN_PHASE moved off 500. `at.period` is a free
  // string on the payload, so a scorer's typo used to raise a Sentry issue and
  // wake someone, for an input the scorer could have retyped. The status
  // assertion above does not catch that on its own: what pages is the
  // `status >= 500` capture branch, so the capture is asserted separately.
  it("does not page the on-call for a period the scorer can retype", async () => {
    sentry.captureException.mockClear();
    const res = await v1(async () => {
      throw new EngineError("UNKNOWN_PHASE", 'period "SO" is not in the declared phase order');
    });
    expect(res.status).toBe(422);
    expect(sentry.captureException).not.toHaveBeenCalled();
    // ...and the branch still fires for a code that really is ours to fix.
    const dup = await v1(async () => {
      throw new EngineError("MODULE_DUPLICATE", "two modules claim icehockey@1.0.0");
    });
    expect(dup.status).toBe(500);
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it("SEQ_CONFLICT carries current_seq (doc 08 §4)", async () => {
    const res = await v1(async () => {
      throw new EngineError("SEQ_CONFLICT", "stale", { expectedSeq: 3, actualSeq: 7 });
    });
    expect(res.status).toBe(409);
    const json = await body(res);
    expect((json.error as { current_seq: number }).current_seq).toBe(7);
  });

  it("maps PaymentRequiredError → 402 with the feature key", async () => {
    const res = await v1(async () => {
      throw new PaymentRequiredError("api.access");
    });
    expect(res.status).toBe(402);
    const json = await body(res);
    expect((json.error as { feature: string }).feature).toBe("api.access");
  });

  it("maps AuthError → 401 and HttpError → its status", async () => {
    expect((await v1(async () => { throw new AuthError("no"); })).status).toBe(401);
    expect((await v1(async () => { throw new HttpError(404, "gone"); })).status).toBe(404);
    expect((await v1(async () => { throw new HttpError(429, "slow"); })).status).toBe(429);
  });

  it("maps ZodError → 400 with issues", async () => {
    const res = await v1(async () => z.object({ n: z.number() }).parse({ n: "x" }));
    expect(res.status).toBe(400);
    const json = await body(res);
    expect((json.error as { code: string }).code).toBe("VALIDATION");
    expect((json.error as { issues: unknown[] }).issues).toBeInstanceOf(Array);
  });
});

describe("parseBody", () => {
  const schema = z.object({ name: z.string() });

  it("parses valid JSON", async () => {
    const req = new Request("http://x/", { method: "POST", body: JSON.stringify({ name: "a" }) });
    expect(await parseBody(req, schema)).toEqual({ name: "a" });
  });

  it("400s malformed JSON", async () => {
    const req = new Request("http://x/", { method: "POST", body: "{nope" });
    await expect(parseBody(req, schema)).rejects.toMatchObject({ status: 400 });
  });
});

describe("cursor pagination", () => {
  it("round-trips a cursor opaquely", () => {
    const cursor = encodeCursor("2026-07-04T00:00:00.000Z", "abc");
    expect(cursor).not.toContain("2026"); // opaque
    expect(decodeCursor(cursor)).toEqual({ createdAt: "2026-07-04T00:00:00.000Z", id: "abc" });
  });

  it("rejects garbage cursors with 400", () => {
    expect(() => decodeCursor("!!!not-base64!!!")).toThrowError(HttpError);
  });

  it("listQuery clamps limit and rejects non-integers", () => {
    expect(listQuery(new Request("http://x/?limit=5000")).limit).toBe(200);
    expect(listQuery(new Request("http://x/")).limit).toBe(50);
    expect(() => listQuery(new Request("http://x/?limit=abc"))).toThrowError(HttpError);
    expect(() => listQuery(new Request("http://x/?limit=0"))).toThrowError(HttpError);
  });

  it("page() trims the over-fetch row and mints nextCursor from the last kept row", () => {
    const rows = [1, 2, 3].map((n) => ({
      id: `id-${n}`,
      created_at: `2026-07-0${n}T00:00:00.000Z`,
    }));
    const result = page(rows, 2);
    expect(result.items).toHaveLength(2);
    expect(result.nextCursor).not.toBeNull();
    expect(decodeCursor(result.nextCursor as string).id).toBe("id-2");
    expect(page(rows, 3).nextCursor).toBeNull();
  });
});
