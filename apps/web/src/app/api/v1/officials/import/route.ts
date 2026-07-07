import { v1, reply } from "@/server/api-v1/http";
import { requireAuth } from "@/server/api-v1/auth";
import { HttpError } from "@/lib/errors";
import { importOfficials } from "@/server/usecases/officials";

/** POST /api/v1/officials/import — bulk CSV/XLSX (Name, Roles, MaxPerDay). */
export async function POST(req: Request) {
  return v1(async () => {
    const auth = await requireAuth(req, "write");
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new HttpError(400, "multipart 'file' field required");
    const result = await importOfficials(
      auth,
      file.name,
      file.type || null,
      Buffer.from(await file.arrayBuffer()),
    );
    return reply(201, result);
  });
}
