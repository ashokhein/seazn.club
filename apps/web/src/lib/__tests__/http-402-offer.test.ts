// The 402 WIRE SHAPE (v17 gap #293).
//
// `assertWithinGroupCap` / `assertMayOwnAnotherOrg` can stamp
// `{ offer: "extra_org" }` on the error all they like — if the envelope drops
// it, the UI (Task 7) and the smoke test (Task 9) see a dead-end 402 and
// nothing tells us. `lib/http.ts`'s `handler` is the only serialiser on the
// path both cap refusals actually take (`POST /api/orgs` and
// `POST /api/billing/group/attach` are both non-v1 routes), so it is the thing
// worth pinning: `extra` merges in at the TOP LEVEL, next to feature_key.
import { describe, expect, it } from "vitest";
import { handler } from "@/lib/http";
import { PaymentRequiredError } from "@/lib/errors";

const body = async (err: unknown) => {
  const res = await handler(async () => {
    throw err;
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
};

describe("handler — 402 envelope", () => {
  it("merges PaymentRequiredError.extra into the body at the top level", async () => {
    const r = await body(new PaymentRequiredError("orgs.max_owned", { offer: "extra_org" }));
    expect(r.status).toBe(402);
    expect(r.json.offer).toBe("extra_org");
    // The pre-existing contract must survive the merge, not be replaced by it.
    expect(r.json.ok).toBe(false);
    expect(r.json.feature_key).toBe("orgs.max_owned");
    expect(typeof r.json.reason).toBe("string");
  });

  it("carries no offer key when the error carries no extra", async () => {
    const r = await body(new PaymentRequiredError("orgs.max_owned"));
    expect(r.status).toBe(402);
    // Discriminator: the 402 itself must still be the fully-formed one, so
    // "no offer" cannot be satisfied by "no 402 was produced".
    expect(r.json.feature_key).toBe("orgs.max_owned");
    expect("offer" in r.json).toBe(false);
  });
});
