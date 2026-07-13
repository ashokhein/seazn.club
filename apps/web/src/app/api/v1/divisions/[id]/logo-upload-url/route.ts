import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { divisionLogoPath, getSignedUploadUrl } from "@/lib/supabase-storage";

type Ctx = { params: Promise<{ id: string }> };

/** Signed upload URL for the division card logo (v8). Editors only; no plan
 *  gate — the tile is core card identity, not Pro branding. The client PUTs
 *  the file, then PATCHes the division with the returned storage_path. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "division", id, "write");
    const path = divisionLogoPath(auth.orgId, id);
    const { url, token } = await getSignedUploadUrl(path);
    return { upload_url: url, token, storage_path: path };
  });
}
