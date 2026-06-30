import { requireTournamentEditor } from "@/lib/auth";
import { handler } from "@/lib/http";
import { HttpError } from "@/lib/errors";
import { removePlayer } from "@/lib/tournament";
import { sql } from "@/lib/db";
import { z } from "zod";

const patchSchema = z.object({
  image_storage_path: z.string().max(500).nullable().optional(),
  image_url: z.string().max(1_500_000).nullable().optional(),
}).strict();

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; playerId: string }> },
) {
  return handler(async () => {
    const { id, playerId } = await params;
    await requireTournamentEditor(id);
    const body = patchSchema.parse(await req.json());

    const [existing] = await sql`
      select id from players where id = ${playerId} and tournament_id = ${id}`;
    if (!existing) throw new HttpError(404, "Player not found");

    const updates: Record<string, unknown> = {};
    if ("image_storage_path" in body) updates.image_storage_path = body.image_storage_path;
    if ("image_url" in body) updates.image_url = body.image_url;

    if (Object.keys(updates).length === 0) return { ok: true };

    await sql`update players set ${sql(updates)} where id = ${playerId}`;
    return { ok: true };
  });
}

/** Remove a player from a tournament that has not started yet. */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string; playerId: string }> },
) {
  return handler(async () => {
    const { id, playerId } = await params;
    const { user, orgId } = await requireTournamentEditor(id);
    await removePlayer(id, orgId, playerId, user.display_name);
    return { ok: true };
  });
}
