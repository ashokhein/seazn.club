import { sql } from "@/lib/db";
import { requireSuperadmin } from "@/lib/admin";
import { handler, HttpError } from "@/lib/http";
import { adminDowngrade, downgradeFreezePreview } from "@/server/usecases/admin-plan";
import { z } from "zod";

type Ctx = { params: Promise<{ id: string }> };

/** Freeze preview — what an immediate downgrade would make read-only. The
 *  panel shows this list BEFORE the typed confirm (v3/08 §1). */
export async function GET(_req: Request, { params }: Ctx) {
  return handler(async () => {
    const { id } = await params;
    await requireSuperadmin();
    const [org] = await sql<{ id: string }[]>`select id from organizations where id = ${id}`;
    if (!org) throw new HttpError(404, "Organization not found");
    return downgradeFreezePreview(id);
  });
}

const schema = z.object({ reason: z.string().min(1).max(500) }).strict();

/** Immediate downgrade to Community (comped orgs; Stripe orgs are refused). */
export async function POST(req: Request, { params }: Ctx) {
  return handler(async () => {
    const { id } = await params;
    const staff = await requireSuperadmin();
    const { reason } = schema.parse(await req.json());
    const [org] = await sql<{ id: string }[]>`select id from organizations where id = ${id}`;
    if (!org) throw new HttpError(404, "Organization not found");
    return adminDowngrade(staff.id, id, reason);
  });
}
