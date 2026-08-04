import { requireSuperadmin } from "@/lib/admin";
import { handler } from "@/lib/http";
import { fixtureConfigPanel, resnapshotFixtureConfig } from "@/server/usecases/admin-fixture-config";
import { z } from "zod";

const schema = z.object({ reason: z.string().min(1).max(500) }).strict();

/**
 * Re-freeze one fixture's V347 config snapshot from live division + stage
 * config. The escape hatch from the snapshot — see
 * `server/usecases/admin-fixture-config.ts` for why it must exist and what it
 * refuses.
 *
 * SUPERADMIN, not plain staff. The discarded config survives only in the audit
 * row this writes; there is no second copy and no undo. That is a higher bar
 * than reading `/admin/fixtures`, which the staff-only layout already gates.
 *
 * Thin wrapper: the guard, the write and the audit stamp live in the usecase so
 * they can be exercised without a Next request.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handler(async () => {
    const { id } = await params;
    const staff = await requireSuperadmin();
    const { reason } = schema.parse(await req.json());
    await resnapshotFixtureConfig(staff.id, id, reason);
    return { ok: true, panel: await fixtureConfigPanel(id) };
  });
}
