import { sql } from "@/lib/db";
import { requireStaff } from "@/lib/admin";
import { adjustmentsForOrg } from "@/server/usecases/admin-adjustments-log";
import { handler, HttpError } from "@/lib/http";
import { z } from "zod";

const query = z
  .object({
    /** Page size; usecase caps at 200. */
    limit: z.coerce.number().int().positive().optional(),
    /** created_at ISO cursor (exclusive) for keyset paging. */
    before: z.string().datetime().optional(),
  })
  .strict();

/** Read the SPEC-3 §3 unified adjustments log for one org. Any staff may READ
 *  (support included); the write-restriction lives on the T1/T2 mutation
 *  routes. Reads staff_audit_log scoped to this org + the adjustment action
 *  set — no writes, no migration. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handler(async () => {
    const { id } = await params;
    await requireStaff();

    const { searchParams } = new URL(req.url);
    const { limit, before } = query.parse({
      limit: searchParams.get("limit") ?? undefined,
      before: searchParams.get("before") ?? undefined,
    });

    const [org] = await sql<{ id: string }[]>`select id from organizations where id = ${id}`;
    if (!org) throw new HttpError(404, "Organization not found");

    const entries = await adjustmentsForOrg(id, { limit, before });
    return { ok: true, entries };
  });
}
