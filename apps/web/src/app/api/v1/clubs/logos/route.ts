import { v1 } from "@/server/api-v1/http";
import { requireAuth } from "@/server/api-v1/auth";
import { HttpError } from "@/lib/errors";
import { bulkAssignLogos, type LogoFile } from "@/server/usecases/clubs";

/** POST /api/v1/clubs/logos — multipart bulk logo assignment (Jul3/01 §5):
 *  repeated 'files' entries + optional 'mapping' JSON (filename → clubId) and
 *  'assign_remaining' flag for the any-order mode. */
export async function POST(req: Request) {
  return v1(async () => {
    const auth = await requireAuth(req, "write");
    const form = await req.formData();
    const files: LogoFile[] = [];
    for (const entry of form.getAll("files")) {
      if (!(entry instanceof File)) continue;
      files.push({
        filename: entry.name,
        contentType: entry.type,
        bytes: Buffer.from(await entry.arrayBuffer()),
      });
    }
    if (files.length === 0) throw new HttpError(400, "multipart 'files' entries required");
    const mappingRaw = form.get("mapping");
    const mapping = typeof mappingRaw === "string"
      ? (JSON.parse(mappingRaw) as Record<string, string>)
      : {};
    const assignRemaining = form.get("assign_remaining") === "true";
    return bulkAssignLogos(auth, files, mapping, assignRemaining);
  });
}
