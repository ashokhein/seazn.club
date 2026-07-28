// The POST seam that keeps the status and the rest of the body (v17 gap #293,
// Task 6). Pure: a hand-rolled `fetch`, no DOM, no network.
//
// This exists because `lib/client.ts`'s `api()` throws away both, and Task 5
// shipped a 402 carrying `{ offer: "extra_org" }` that a caller has to READ.
// Task 7 renders that offer, so the two properties below are its contract, not
// only this task's.
import { describe, expect, it, vi } from "vitest";
import { postJson } from "@/lib/api-post";

function respond(status: number, body: unknown): typeof fetch {
  return vi.fn(async () =>
    // Real Response, so status/ok/json all behave as they do in a browser.
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  ) as unknown as typeof fetch;
}

describe("postJson", () => {
  it("returns the envelope's data on success", async () => {
    const result = await postJson<{ extraOrgs: number }>(
      "/api/billing/extra-orgs",
      { count: 2 },
      respond(200, { ok: true, data: { extraOrgs: 2 } }),
    );
    expect(result).toEqual({ ok: true, data: { extraOrgs: 2 } });
  });

  it("sends the body as JSON to the given url", async () => {
    const fetchFn = respond(200, { ok: true, data: null });
    await postJson("/api/billing/extra-orgs", { count: 3 }, fetchFn);
    const [url, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("/api/billing/extra-orgs");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ count: 3 });
  });

  it("KEEPS THE STATUS, so a caller can choose its own copy", async () => {
    // The whole point. Four of this route's refusals differ only by status.
    for (const status of [400, 401, 403, 409, 422, 423, 503, 500]) {
      const result = await postJson(
        "/api/billing/extra-orgs",
        { count: 0 },
        respond(status, { ok: false, error: "nope" }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.status).toBe(status);
    }
  });

  it("KEEPS FIELDS OUTSIDE THE ENVELOPE — a 402's offer survives (Task 7)", async () => {
    // `handler`'s 402 branch spreads `...err.extra` at the top level next to
    // feature_key/reason. `api()` reads `reason` and drops `offer`, which is
    // exactly the difference between "upgrade your plan" and "buy a rider".
    const result = await postJson(
      "/api/orgs",
      { name: "x" },
      respond(402, {
        ok: false,
        error: "Plan upgrade required: orgs.max_owned",
        feature_key: "orgs.max_owned",
        reason: "Your current plan covers the most organisations it allows.",
        offer: "extra_org",
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(402);
      expect(result.body.offer).toBe("extra_org");
      expect(result.body.feature_key).toBe("orgs.max_owned");
      expect(result.body.reason).toBe(
        "Your current plan covers the most organisations it allows.",
      );
    }
  });

  it("treats an ok:false body as a failure even on a 200", async () => {
    const result = await postJson("/x", {}, respond(200, { ok: false, error: "nope" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(200);
      expect(result.error).toBe("nope");
    }
  });

  it("reports a rejected fetch as status null, not as a 500", async () => {
    // Null means "nothing is known about the server's opinion". Mapping it to
    // 500 would let an offline browser render a confident server diagnosis.
    const result = await postJson("/x", {}, (() => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBeNull();
      expect(result.body).toEqual({});
    }
  });

  it("survives a non-JSON error body", async () => {
    const html = vi.fn(async () => new Response("<html>502</html>", { status: 502 }));
    const result = await postJson("/x", {}, html as unknown as typeof fetch);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(502);
      expect(result.body).toEqual({});
      expect(result.error).toBe("Request failed.");
    }
  });

  it("never throws, whatever the response", async () => {
    // The control's `finally` clears its busy flag; a throw from here would
    // leave the buttons disabled for ever with no message.
    await expect(postJson("/x", {}, respond(423, { ok: false, error: "in use" }))).resolves.toBeDefined();
  });
});
