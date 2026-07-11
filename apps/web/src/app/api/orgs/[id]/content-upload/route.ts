import { randomUUID } from "node:crypto";
import { requireOrgRole } from "@/lib/auth";
import { getSignedUploadUrl, publicStorageUrl } from "@/lib/supabase-storage";
import { handler } from "@/lib/http";
import { HttpError } from "@/lib/errors";
import { EDITOR_ROLES } from "@/lib/types";
import { z } from "zod";

// Description-editor image uploads (v3/06 §2) — the club-logo pipeline
// reused: the browser PUTs straight to Supabase via a signed URL; only the
// public CDN URL lands in the Markdown. 2MB cap enforced client-side AND by
// the bucket policy; content types pinned here.
const schema = z
  .object({
    content_type: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
  })
  .strict();

const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handler(async () => {
    const { id } = await params;
    await requireOrgRole(id, EDITOR_ROLES);
    const { content_type } = schema.parse(await req.json());
    const ext = EXT[content_type];
    if (!ext) throw new HttpError(415, "Unsupported image type");
    const path = `orgs/${id}/content/${randomUUID()}.${ext}`;
    const { url } = await getSignedUploadUrl(path);
    return { upload_url: url, public_url: publicStorageUrl(path) };
  });
}
