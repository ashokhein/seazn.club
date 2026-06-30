import { getCurrentUser, requireOrgRole } from "@/lib/auth";
import { handler } from "@/lib/http";
import { HttpError } from "@/lib/errors";
import { hasFeature } from "@/lib/entitlements";
import { mintRealtimeToken } from "@/lib/realtime";
import { sql } from "@/lib/db";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handler(async () => {
    const { id } = await params;

    // Resolve org for this tournament
    const [row] = await sql<{ org_id: string }[]>`
      select org_id from tournaments where id = ${id}`;
    if (!row) throw new HttpError(404, "Tournament not found");

    const user = await getCurrentUser();
    if (!user) throw new HttpError(401, "Login required");

    await requireOrgRole(row.org_id, ["owner", "admin", "viewer"]);

    const ok = await hasFeature(row.org_id, "realtime");
    if (!ok) throw new HttpError(403, "Realtime requires Pro plan");

    const token = await mintRealtimeToken(user.id, id);
    const expiresAt = new Date(Date.now() + 3600_000).toISOString();

    return {
      token,
      channel: `tournament:${id}`,
      expires_at: expiresAt,
    };
  });
}
