// v1 kernel: envelope, EngineError→HTTP map, cursor pagination (doc 08 §1/§4).
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { EngineError } from "@seazn/engine/core";
import { AuthError, HttpError, PaymentRequiredError } from "@/lib/errors";
import {
  v1,
  reply,
  parseBody,
  encodeCursor,
  decodeCursor,
  listQuery,
  page,
} from "../http";

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
  ] as const)("maps EngineError %s → %d", async (code, status) => {
    const res = await v1(async () => {
      throw new EngineError(code, "boom");
    });
    expect(res.status).toBe(status);
    const json = await body(res);
    expect(json.ok).toBe(false);
    expect((json.error as { code: string }).code).toBe(code);
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
