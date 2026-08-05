import { requireUser } from "@/lib/auth";
import { handler } from "@/lib/http";
import { waiveDivisionSlot } from "@/server/usecases/admin-divisions";

/**
 * Clear a division's V354 quota-slot consumption. Staff only.
 *
 * Thin wrapper: the staff gate, the write and the audit stamp all live in
 * `waiveDivisionSlot` so they can be exercised without a Next request. This
 * route deliberately does NOT call `requireStaff()` — that would be a SECOND
 * staff check, and it maps to 401, whereas an authenticated non-staff caller
 * asking for a staff action is a 403. `requireUser()` establishes who is
 * asking (401 if nobody); the use case decides whether they may.
 *
 * 204, no body: there is nothing to return. `handler` passes a `Response`
 * straight through rather than wrapping it in the { ok, data } envelope.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handler(async () => {
    const { id } = await params;
    const user = await requireUser();
    await waiveDivisionSlot(user.id, id);
    return new Response(null, { status: 204 });
  });
}
