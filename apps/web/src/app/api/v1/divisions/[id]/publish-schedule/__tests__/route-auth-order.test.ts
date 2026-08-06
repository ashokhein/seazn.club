// The auth door opens BEFORE the request body is parsed — publish-schedule AND
// the /start route it is the twin of.
//
// The same rule six sibling POST handlers were reordered under in #376
// (`create-auth-order.test.ts` carries the argument in full). Both of these
// routes were written after that pass and got the order the other way round:
// they parsed their request schema and only then called `requireResourceAuth`,
// so a caller with no write permission received a 400 describing the schema
// instead of the 403 it had actually earned. The AUTO route two directories
// over — `stages/{id}/schedule/auto` — already authenticates first.
//
// Two costs, and neither needs the caller to be malicious. The schema shape
// leaks to somebody who was never authenticated; and every auth-refusal probe
// that sends a deliberately-minimal or deliberately-invalid body silently
// degrades into a shape-refusal probe, still asserting "403" while the number
// now comes from the validator.
//
// WHY BOTH ROUTES IN ONE FILE. Publish was fixed on its own and `/start` — the
// endpoint that PUBLISHES on its way through, carrying `PublishScheduleRequest`
// verbatim as `StartDivisionRequest` — was left parsing first, so the fix
// covered one half of a pair the console drives from the same two buttons. A
// table over both is the shape that cannot be half-applied again: adding a
// third gated route here is one row.
//
// Non-vacuity: the second case per route sends the SAME invalid body under a
// manage key and must still get its 400. Without it, a handler that refused
// everything with a 403 would pass the first case for entirely the wrong
// reason.
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { seedOrg, seedFutureDivision } from "@/server/usecases/__tests__/_seed";
import { createApiKey } from "@/server/usecases/api-keys";
import { POST as publishSchedule } from "@/app/api/v1/divisions/[id]/publish-schedule/route";
import { POST as startDivision } from "@/app/api/v1/divisions/[id]/start/route";

const HAS_DB = !!process.env.DATABASE_URL;

/** `pro` carries `api.access` but not `api.write`, so minting a manage key
 *  needs the override — same lever the sibling suite uses. This suite is about
 *  the ORDER of the two doors, not about which plan opens them. */
async function allowApiWrite(auth: AuthCtx): Promise<void> {
  await sql`
    insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
    values (${auth.orgId}, 'api.write', true, 'test')
    on conflict (org_id, feature_key) do update set bool_value = true`;
  await invalidateOrgEntitlements(auth.orgId);
}

/** `reason` is `z.string().max(500)` on BOTH schemas, so 501 characters is
 *  rejected by the schema and by nothing else — a body whose ONLY problem is
 *  its shape. */
const INVALID_BODY = { reason: "x".repeat(501) };

type Handler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

/** Every division POST that publishes, and therefore every one that carries a
 *  body an unauthenticated caller must never be told about. */
const GATED_ROUTES: { name: string; segment: string; handler: Handler }[] = [
  { name: "publish-schedule", segment: "publish-schedule", handler: publishSchedule },
  { name: "start", segment: "start", handler: startDivision },
];

function keyedPost(segment: string, divisionId: string, secret: string, body: unknown): Request {
  return new Request(`https://test.local/api/v1/divisions/${divisionId}/${segment}`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

describe.skipIf(!HAS_DB)("the gated division POSTs authenticate before they parse", () => {
  for (const { name, segment, handler } of GATED_ROUTES) {
    describe(`POST ${name}`, () => {
      it("refuses a read-scoped key for SCOPE, not for the shape of its body", async () => {
        const { auth } = await seedOrg("pro");
        const { division } = await seedFutureDivision(auth);
        const { secret } = await createApiKey(auth, { name: "reader", scopes: ["read"] });

        const res = await handler(
          keyedPost(segment, division.id, secret, INVALID_BODY),
          ctx(division.id),
        );
        const json = (await res.json()) as { error: { code: string } };

        expect(res.status).toBe(403);
        expect(json.error.code).not.toBe("VALIDATION");
      });

      it("still validates the body once the caller is authorised", async () => {
        const { auth } = await seedOrg("pro");
        const { division } = await seedFutureDivision(auth);
        await allowApiWrite(auth);
        const { secret } = await createApiKey(auth, { name: "manager", scopes: ["manage"] });

        const res = await handler(
          keyedPost(segment, division.id, secret, INVALID_BODY),
          ctx(division.id),
        );
        const json = (await res.json()) as { error: { code: string } };

        expect(res.status).toBe(400);
        expect(json.error.code).toBe("VALIDATION");
      });
    });
  }
});
