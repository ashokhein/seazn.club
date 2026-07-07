import { v1, reply } from "@/server/api-v1/http";
import { requireAuth } from "@/server/api-v1/auth";
import { HttpError } from "@/lib/errors";
import { createImport } from "@/server/usecases/imports";
import type { ImportField } from "@/server/usecases/import-parse";

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** POST /api/v1/imports — multipart upload → { importId, plan }. Dry-run:
 *  writes nothing but the stored parse+plan (Jul3/01 §6). */
export async function POST(req: Request) {
  return v1(async () => {
    const auth = await requireAuth(req, "write");
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new HttpError(400, "multipart 'file' field required");
    if (file.size > MAX_UPLOAD_BYTES) throw new HttpError(413, "file exceeds the 10 MB limit");
    const mappingRaw = form.get("mapping");
    const configRaw = form.get("config");
    const preview = await createImport(auth, {
      filename: file.name,
      contentType: file.type || null,
      buffer: Buffer.from(await file.arrayBuffer()),
      mapping: typeof mappingRaw === "string"
        ? (JSON.parse(mappingRaw) as Record<string, ImportField>)
        : undefined,
      config: typeof configRaw === "string" ? JSON.parse(configRaw) : undefined,
    });
    return reply(201, preview);
  });
}
