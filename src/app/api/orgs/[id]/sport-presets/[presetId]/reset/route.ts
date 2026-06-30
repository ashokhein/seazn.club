import { requireOrgRole } from "@/lib/auth";
import { handler } from "@/lib/http";
import { resetSystemSportPreset } from "@/lib/sport-presets";
import { EDITOR_ROLES } from "@/lib/types";

/** Reset a built-in sport preset to factory defaults. */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string; presetId: string }> },
) {
  return handler(async () => {
    const { id, presetId } = await params;
    await requireOrgRole(id, EDITOR_ROLES);

    const { sql } = await import("@/lib/db");
    const [row] = await sql<{ sport_key: string }[]>`
      select sport_key from org_sport_presets
      where id = ${presetId} and org_id = ${id}`;
    if (!row) throw new Error("Sport preset not found");

    const updated = await resetSystemSportPreset(id, row.sport_key);
    if (!updated) {
      throw new Error("Only built-in sport presets can be reset");
    }
    return updated;
  });
}
