import { sql } from "@/lib/db";
import { requireSuperadmin } from "@/lib/admin";
import { handler, HttpError } from "@/lib/http";
import { compToPro } from "@/server/usecases/admin-plan";
import { z } from "zod";

const schema = z
  .object({
    /** ISO date the comp ends; omitted/null = forever. */
    until: z.iso.date().nullable().optional(),
    reason: z.string().min(1).max(500),
  })
  .strict();

/** Comp an org to Pro (v3/08 §1). Superadmin; reason lands in the audit. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handler(async () => {
    const { id } = await params;
    const staff = await requireSuperadmin();
    const { until, reason } = schema.parse(await req.json());
    const [org] = await sql<{ id: string }[]>`select id from organizations where id = ${id}`;
    if (!org) throw new HttpError(404, "Organization not found");
    await compToPro(staff.id, id, until ? new Date(until) : null, reason);
    return { ok: true };
  });
}
