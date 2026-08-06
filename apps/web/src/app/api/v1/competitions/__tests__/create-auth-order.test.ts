// #376 — the auth door opens BEFORE the request body is parsed.
//
// `POST /api/v1/competitions` used to call `parseBody` first, so a caller with
// no permission to create anything received a 400 describing the schema rather
// than the 401/403 it had actually earned. That costs twice over: the schema
// shape leaks to a caller who was never authenticated, and every auth-refusal
// probe quietly degrades into a shape-refusal probe — the assertion still says
// "403" but the number is now coming from the validator, not the auth door.
// Making `ends_on` mandatory (#376 part B) turned four such probes over on this
// branch alone, in `e2e/api-keys.spec.ts` and `scripts/smoke.ts`.
//
// Five sibling POST handlers were reordered in the same commit and are bound by
// the same rule — `clubs`, `officials`, `persons`, `teams` and
// `pools/{id}/clear-entrants`. Competitions is the one pinned here because it
// is the route the regression was found on, and because all six now share the
// single shape `requireAuth(req, scope)` → `parseBody(...)`.
//
// Non-vacuity: the second case sends the SAME invalid body under a manage key
// and must still get its 400. Without it, a handler that refused everything
// with a 403 would pass the first case for entirely the wrong reason.
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createApiKey } from "@/server/usecases/api-keys";
import { seedOrg } from "@/server/usecases/__tests__/_seed";
import { POST } from "@/app/api/v1/competitions/route";

const HAS_DB = !!process.env.DATABASE_URL;

/** `pro` carries `api.access` but not `api.write`, so minting a manage key
 *  needs the override — same lever as `api-key-scopes.test.ts`. This suite is
 *  about the ORDER of the two doors, not about which plan opens them. */
async function allowApiWrite(auth: AuthCtx): Promise<void> {
  await sql`
    insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
    values (${auth.orgId}, 'api.write', true, 'test')
    on conflict (org_id, feature_key) do update set bool_value = true`;
  await invalidateOrgEntitlements(auth.orgId);
}

/** Missing the now-required `ends_on` (#376 part B) — the minimal body an
 *  auth-refusal probe sends when it only means "I should not be allowed here". */
const INVALID_BODY = { name: "Nope" };

function keyedPost(secret: string, body: unknown): Request {
  return new Request("https://test.local/api/v1/competitions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

describe.skipIf(!HAS_DB)("POST /api/v1/competitions authenticates before it parses", () => {
  it("refuses a read-scoped key for SCOPE, not for the shape of its body", async () => {
    const { auth } = await seedOrg("pro");
    const { secret } = await createApiKey(auth, { name: "reader", scopes: ["read"] });

    const res = await POST(keyedPost(secret, INVALID_BODY));
    const json = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(403);
    expect(json.error.code).not.toBe("VALIDATION");
  });

  it("still validates the body once the caller is authorised", async () => {
    const { auth } = await seedOrg("pro");
    await allowApiWrite(auth);
    const { secret } = await createApiKey(auth, { name: "manager", scopes: ["manage"] });

    const res = await POST(keyedPost(secret, INVALID_BODY));
    const json = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(400);
    expect(json.error.code).toBe("VALIDATION");
  });
});
