// #404 Task 7 — the API surface over the reversible merge, and the two gates
// that only exist at the HTTP boundary:
//
//  1. **the confirmation gate.** `mergePersons` cannot tell a confirmed merge
//     from an unconfirmed one — the usecase merges whatever it is handed. The
//     organiser's "yes" is a wire field, so it is tested on the wire.
//  2. **the API-key ban.** A merge is a human act and the ledger records who
//     confirmed it, so no key may reach any of the three routes
//     (`NEVER_KEY_ROUTES` precedent, same as `DELETE /competitions/:id`).
//
// The routes are exercised as REAL handlers over a REAL scoped key — mocking
// `requireResourceAuth` would delete the very thing under test. Only the
// session door is faked, one layer down: `requireUser` says who is signed in,
// and the real `getUserOrgs`/`getOrgRole`/`resolveActiveOrg` resolve the org
// from the database, so the tenancy assertion below is a real one.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const HAS_DB = !!process.env.DATABASE_URL;

const authState = vi.hoisted(() => ({ userId: "" }));

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireUser: async () => ({ id: authState.userId }),
    getCurrentUser: async () => ({ id: authState.userId }),
    // No cookie: `resolveActiveOrg` falls back to the user's first org, which
    // is the only org each seeded owner belongs to.
    getActiveOrgId: async () => null,
  };
});

// `resolveActiveOrg` repairs the cookie on the fallback path; outside a Next
// request scope `cookies()` throws, so the jar is a no-op.
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));

import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { matchKeyRoute } from "@/server/api-v1/key-scopes";
import { createApiKey } from "@/server/usecases/api-keys";
import { seedOrg } from "@/server/usecases/__tests__/_seed";
import { POST as mergeRoute } from "@/app/api/v1/persons/[id]/merge/route";
import { GET as duplicatesRoute } from "@/app/api/v1/persons/duplicates/route";
import { POST as reverseRoute } from "@/app/api/v1/persons/merges/[id]/reverse/route";
import { GET as mergesRoute } from "@/app/api/v1/persons/merges/route";

const rnd = () => randomUUID().slice(0, 8);

/** A signed-in organiser of a fresh pro org (pro carries api.access, which the
 *  key-ban tests need to reach the route allowlist rather than a 402). */
async function organiser(): Promise<AuthCtx> {
  const { auth } = await seedOrg("pro");
  authState.userId = auth.userId!;
  return auth;
}

async function person(
  orgId: string,
  opts: { full_name?: string; dob?: string | null } = {},
): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into persons (org_id, full_name, dob, consent, lane)
    values (${orgId}, ${opts.full_name ?? "Alex Morgan"}, ${opts.dob ?? null},
            ${sql.json({} as never)}, 'player')
    returning id`;
  return row!.id;
}

function sessionReq(method: string, path: string, body?: unknown): Request {
  return new Request(`https://test.local/api/v1${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function keyedReq(secret: string, method: string, path: string, body?: unknown): Request {
  return new Request(`https://test.local/api/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

interface Envelope {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string };
}

async function read(res: Response): Promise<{ status: number; body: Envelope }> {
  return { status: res.status, body: (await res.json()) as Envelope };
}

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

describe.skipIf(!HAS_DB)("POST /persons/:id/merge — the confirmation gate", () => {
  beforeEach(() => {
    authState.userId = "";
  });

  it("refuses an unconfirmed merge with 422, and leaves both people alive", async () => {
    const auth = await organiser();
    const survivor = await person(auth.orgId, { full_name: "Sam Reed" });
    const duplicate = await person(auth.orgId, { full_name: "Sam Reed" });

    const { status, body } = await read(
      await mergeRoute(
        sessionReq("POST", `/persons/${survivor}/merge`, { duplicate_id: duplicate }),
        ctx(survivor),
      ),
    );
    expect(status).toBe(422);
    expect(body.error?.code).toBe("MERGE_NOT_CONFIRMED");

    // Nothing happened: `confirmed` is a gate, not a formality.
    const [row] = await sql<{ merged_into: string | null }[]>`
      select merged_into from persons where id = ${duplicate}`;
    expect(row!.merged_into).toBeNull();
  });

  it("refuses confirmed:false with 422 — the field is a literal true, not a boolean", async () => {
    const auth = await organiser();
    const survivor = await person(auth.orgId, { full_name: "Jo Vance" });
    const duplicate = await person(auth.orgId, { full_name: "Jo Vance" });

    const { status, body } = await read(
      await mergeRoute(
        sessionReq("POST", `/persons/${survivor}/merge`, {
          duplicate_id: duplicate,
          confirmed: false,
        }),
        ctx(survivor),
      ),
    );
    expect(status).toBe(422);
    expect(body.error?.code).toBe("MERGE_NOT_CONFIRMED");
  });

  it("merges on confirmed:true and returns merge_id, survivor and revealed", async () => {
    const auth = await organiser();
    const survivor = await person(auth.orgId, { full_name: "Kit Barlow" });
    const duplicate = await person(auth.orgId, { full_name: "Kit Barlow" });

    const { status, body } = await read(
      await mergeRoute(
        sessionReq("POST", `/persons/${survivor}/merge`, {
          duplicate_id: duplicate,
          confirmed: true,
        }),
        ctx(survivor),
      ),
    );
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data).toMatchObject({
      merge_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      survivor: expect.objectContaining({ id: survivor, full_name: "Kit Barlow" }),
      revealed: expect.any(Array),
    });

    const [row] = await sql<{ merged_into: string | null }[]>`
      select merged_into from persons where id = ${duplicate}`;
    expect(row!.merged_into).toBe(survivor);
  });

  it("passes allow_dob_mismatch through — refused without it, merged with it", async () => {
    const auth = await organiser();
    const name = `Dob Case ${rnd()}`;
    const survivor = await person(auth.orgId, { full_name: name, dob: "1990-01-01" });
    const duplicate = await person(auth.orgId, { full_name: name, dob: "1991-02-02" });

    const refused = await read(
      await mergeRoute(
        sessionReq("POST", `/persons/${survivor}/merge`, {
          duplicate_id: duplicate,
          confirmed: true,
        }),
        ctx(survivor),
      ),
    );
    expect(refused.status).toBe(422);
    expect(refused.body.error?.code).toBe("MERGE_DOB_MISMATCH");

    const allowed = await read(
      await mergeRoute(
        sessionReq("POST", `/persons/${survivor}/merge`, {
          duplicate_id: duplicate,
          confirmed: true,
          allow_dob_mismatch: true,
        }),
        ctx(survivor),
      ),
    );
    expect(allowed.status).toBe(200);
    expect(allowed.body.data?.merge_id).toEqual(expect.any(String));
  });
});

describe.skipIf(!HAS_DB)("POST /persons/merges/:id/reverse", () => {
  async function mergedPair(): Promise<{ auth: AuthCtx; mergeId: string }> {
    const auth = await organiser();
    const name = `Rev ${rnd()}`;
    const survivor = await person(auth.orgId, { full_name: name });
    const duplicate = await person(auth.orgId, { full_name: name });
    const { body } = await read(
      await mergeRoute(
        sessionReq("POST", `/persons/${survivor}/merge`, {
          duplicate_id: duplicate,
          confirmed: true,
        }),
        ctx(survivor),
      ),
    );
    return { auth, mergeId: body.data!.merge_id as string };
  }

  it("refuses an unconfirmed reversal with 422", async () => {
    const { mergeId } = await mergedPair();
    const { status, body } = await read(
      await reverseRoute(sessionReq("POST", `/persons/merges/${mergeId}/reverse`, {}), ctx(mergeId)),
    );
    expect(status).toBe(422);
    expect(body.error?.code).toBe("MERGE_NOT_CONFIRMED");

    const [row] = await sql<{ reversed_at: Date | null }[]>`
      select reversed_at from person_merges where id = ${mergeId}`;
    expect(row!.reversed_at).toBeNull();
  });

  it("reverses on confirmed:true, and 409s the second reversal of the same merge", async () => {
    const { mergeId } = await mergedPair();

    const first = await read(
      await reverseRoute(
        sessionReq("POST", `/persons/merges/${mergeId}/reverse`, { confirmed: true }),
        ctx(mergeId),
      ),
    );
    expect(first.status).toBe(200);
    expect(first.body.ok).toBe(true);

    const second = await read(
      await reverseRoute(
        sessionReq("POST", `/persons/merges/${mergeId}/reverse`, { confirmed: true }),
        ctx(mergeId),
      ),
    );
    expect(second.status).toBe(409);
    expect(second.body.error?.code).toBe("MERGE_ALREADY_REVERSED");
  });
});

describe.skipIf(!HAS_DB)("GET /persons/duplicates", () => {
  it("ranks the caller's own org and never another org's rows", async () => {
    // The other org first, so its rows are older — a query that forgot its
    // tenant would rank them at the top, not silently at the bottom.
    const other = await organiser();
    const otherName = `Foreign ${rnd()}`;
    const foreignA = await person(other.orgId, { full_name: otherName });
    const foreignB = await person(other.orgId, { full_name: otherName });

    const auth = await organiser();
    const mine = `Mine ${rnd()}`;
    const a = await person(auth.orgId, { full_name: mine });
    const b = await person(auth.orgId, { full_name: mine });

    const { status, body } = await read(
      await duplicatesRoute(sessionReq("GET", "/persons/duplicates")),
    );
    expect(status).toBe(200);
    const items = body.data!.items as { a: { id: string }; b: { id: string }; score: number }[];
    const ids = items.flatMap((i) => [i.a.id, i.b.id]);
    expect(ids).toEqual(expect.arrayContaining([a, b]));
    expect(ids).not.toContain(foreignA);
    expect(ids).not.toContain(foreignB);
    expect(items.every((i) => i.score > 0)).toBe(true);
  });
});

describe.skipIf(!HAS_DB)("API keys are refused on every merge surface", () => {
  it("the route allowlist has no entry for any of the three", () => {
    expect(matchKeyRoute("POST", "/api/v1/persons/11111111-1111-1111-1111-111111111111/merge")).toBeNull();
    expect(matchKeyRoute("GET", "/api/v1/persons/duplicates")).toBeNull();
    expect(matchKeyRoute("POST", "/api/v1/persons/merges/11111111-1111-1111-1111-111111111111/reverse")).toBeNull();
  });

  it("bars the merge log too — a read key would have walked in through /persons/:id", async () => {
    // Not vacuous: `/persons/merges` is matched by the `GET /persons/:id` rule,
    // so absence from RULES is NOT enough here — only the explicit ban closes it.
    expect(matchKeyRoute("GET", "/api/v1/persons/merges")).toBeNull();

    const auth = await organiser();
    const { secret } = await createApiKey(auth, { name: `k-${rnd()}`, scopes: ["read"] });
    const { status, body } = await read(
      await mergesRoute(keyedReq(secret, "GET", "/persons/merges")),
    );
    expect(status).toBe(403);
    expect(body.error?.message).toMatch(/cannot access this endpoint/);
  });

  it("a real read key is 403 on merge, reverse and the duplicate queue", async () => {
    const auth = await organiser();
    const name = `Keyed ${rnd()}`;
    const survivor = await person(auth.orgId, { full_name: name });
    const duplicate = await person(auth.orgId, { full_name: name });
    const { secret } = await createApiKey(auth, { name: `k-${rnd()}`, scopes: ["read"] });
    const mergeId = randomUUID();

    const calls: [string, Promise<Response>][] = [
      [
        "merge",
        mergeRoute(
          keyedReq(secret, "POST", `/persons/${survivor}/merge`, {
            duplicate_id: duplicate,
            confirmed: true,
          }),
          ctx(survivor),
        ),
      ],
      ["duplicates", duplicatesRoute(keyedReq(secret, "GET", "/persons/duplicates"))],
      [
        "reverse",
        reverseRoute(
          keyedReq(secret, "POST", `/persons/merges/${mergeId}/reverse`, { confirmed: true }),
          ctx(mergeId),
        ),
      ],
    ];

    for (const [label, call] of calls) {
      const { status, body } = await read(await call);
      expect(status, label).toBe(403);
      // The refusal must be the key ban itself, not a scope or entitlement
      // 403 that would evaporate the day someone buys a bigger plan.
      expect(body.error?.message, label).toMatch(/cannot access this endpoint/);
    }

    // And the merge did not happen behind the 403.
    const [row] = await sql<{ merged_into: string | null }[]>`
      select merged_into from persons where id = ${duplicate}`;
    expect(row!.merged_into).toBeNull();
  });
});

// #404 Task 8b — the merge log has to outlive the tab. Undo is unbounded by
// decision (Art. 16 rectification has no expiry), but the panel held its history
// in React state, so a refresh took every Undo control with it. This is the read
// that makes the decision real.
describe.skipIf(!HAS_DB)("GET /persons/merges", () => {
  /** Merge a fresh same-named pair in `auth`'s org and hand back the ledger id. */
  async function mergeOne(auth: AuthCtx, label: string): Promise<string> {
    const survivor = await person(auth.orgId, { full_name: label });
    const duplicate = await person(auth.orgId, { full_name: label });
    const { body } = await read(
      await mergeRoute(
        sessionReq("POST", `/persons/${survivor}/merge`, {
          duplicate_id: duplicate,
          confirmed: true,
        }),
        ctx(survivor),
      ),
    );
    return body.data!.merge_id as string;
  }

  it("lists this org's merges newest-first with their reversal stamp, and no other org's", async () => {
    // The foreign org merges FIRST, so its row is the oldest — a read that
    // forgot its tenant would put it at the bottom, not somewhere loud.
    const other = await organiser();
    const foreign = await mergeOne(other, `Foreign ${rnd()}`);

    const auth = await organiser();
    const older = await mergeOne(auth, `Mine older ${rnd()}`);
    const newer = await mergeOne(auth, `Mine newer ${rnd()}`);
    await reverseRoute(
      sessionReq("POST", `/persons/merges/${older}/reverse`, { confirmed: true }),
      ctx(older),
    );

    const { status, body } = await read(await mergesRoute(sessionReq("GET", "/persons/merges")));
    expect(status).toBe(200);
    const items = body.data!.items as {
      merge_id: string;
      survivor_name: string;
      absorbed_name: string;
      reversed_at: string | null;
    }[];
    expect(items.map((i) => i.merge_id)).toEqual([newer, older]);
    expect(items.map((i) => i.merge_id)).not.toContain(foreign);
    // A reversed merge stays in the log with its stamp — it is the audit trail,
    // and the panel needs the stamp to know which rows still offer Undo.
    expect(items[0]!.reversed_at).toBeNull();
    expect(typeof items[1]!.reversed_at).toBe("string");
    // Names, so the panel can label a row it never saw merged.
    expect(items[0]!.survivor_name).toMatch(/^Mine newer /);
    expect(items[0]!.absorbed_name).toMatch(/^Mine newer /);
  });
});
