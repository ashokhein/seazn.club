import { sql } from "@/lib/db";
import { requireSuperadmin, SUSPENSION_ACTIONS } from "@/lib/admin";
import { handler, HttpError } from "@/lib/http";
import { setOrgSuspension } from "@/server/usecases/admin-orgs";
import { z } from "zod";

const schema = z.object({
  // Derived, not retyped: the accepted verb IS the audited action string, and
  // the adjustments-log allowlist reads the same constant.
  action: z.enum(SUSPENSION_ACTIONS),
  reason: z.string().min(1).max(500),
}).strict();

/** Suspend or reactivate an organization. Superadmin only. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handler(async () => {
    const { id } = await params;
    const staff = await requireSuperadmin();
    const { action, reason } = schema.parse(await req.json());

    const [org] = await sql<{ id: string }[]>`select id from organizations where id = ${id}`;
    if (!org) throw new HttpError(404, "Organization not found");

    // Thin wrapper: the write, the cache bust and the audit stamp live in the
    // usecase so they can be exercised without a Next request. Reached only
    // after requireSuperadmin and the 404 — an unauthorized or unknown-org
    // request must never bust a live org's cache.
    const status = await setOrgSuspension(staff.id, id, action, reason);
    return { ok: true, status };
  });
}
