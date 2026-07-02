import { handler } from "@/lib/http";
import { HttpError } from "@/lib/errors";
import { requireOrgRole } from "@/lib/auth";
import { hasFeature } from "@/lib/entitlements";
import { getSignedUploadUrl, orgLogoPath } from "@/lib/supabase-storage";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handler(async () => {
    const { id } = await params;
    await requireOrgRole(id, ["owner", "admin"]);

    const ok = await hasFeature(id, "branding");
    if (!ok) throw new HttpError(402, "Org logo requires Pro plan");

    const path = orgLogoPath(id);
    const { url, token } = await getSignedUploadUrl(path);

    return { upload_url: url, token, storage_path: path };
  });
}
