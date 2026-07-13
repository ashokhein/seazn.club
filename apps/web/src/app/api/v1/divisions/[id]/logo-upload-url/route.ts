import { v1 } from "@/server/api-v1/http";
import { HttpError } from "@/lib/errors";
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
    // Keyless envs (CI smoke, bare local setups) degrade to a clear 503
    // instead of a 500 from the storage client — Stripe-guard pattern.
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      throw new HttpError(503, "Storage is not configured");
    }
    const path = divisionLogoPath(auth.orgId, id);
    const { url, token } = await getSignedUploadUrl(path);
    return { upload_url: url, token, storage_path: path };
  });
}
