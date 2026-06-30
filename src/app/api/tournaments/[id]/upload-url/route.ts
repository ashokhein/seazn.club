import { handler } from "@/lib/http";
import { HttpError } from "@/lib/errors";
import { requireOrgRole } from "@/lib/auth";
import { hasFeature } from "@/lib/entitlements";
import { sql } from "@/lib/db";
import { getSignedUploadUrl, playerAvatarPath } from "@/lib/supabase-storage";
import { z } from "zod";

const schema = z.object({ player_id: z.string().uuid() }).strict();

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handler(async () => {
    const { id } = await params;
    const [t] = await sql<{ org_id: string }[]>`
      select org_id from tournaments where id = ${id}`;
    if (!t) throw new HttpError(404, "Tournament not found");

    await requireOrgRole(t.org_id, ["owner", "admin"]);

    const ok = await hasFeature(t.org_id, "branding");
    if (!ok) throw new HttpError(402, "Player photo uploads require Pro plan");

    const { player_id } = schema.parse(await req.json());

    // Confirm player belongs to this tournament
    const [p] = await sql`
      select id from players where id = ${player_id} and tournament_id = ${id}`;
    if (!p) throw new HttpError(404, "Player not found");

    const path = playerAvatarPath(t.org_id, id, player_id);
    const { url, token } = await getSignedUploadUrl(path);

    return { upload_url: url, token, storage_path: path };
  });
}
