import { v1, reply, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { CreateEntrants } from "@/server/api-v1/schemas";
import { listEntrants, createEntrants } from "@/server/usecases/entrants";
import { createImport } from "@/server/usecases/imports";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "division", id, "read");
    const query = new URL(req.url).searchParams;
    const clubId = query.get("club_id") ?? undefined;
    const teamId = query.get("team_id") ?? undefined;
    return listEntrants(auth, id, { clubId, teamId });
  });
}

/** Register one entrant, a JSON array for bulk registration, or a multipart
 *  CSV/XLSX upload — the doc 08 §3 bulk-import hook, now a division-pinned
 *  alias into the Jul3/01 import planner (returns { importId, plan }). */
export async function POST(req: Request, { params }: Ctx) {
  return v1<unknown>(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "division", id, "write");
    if (req.headers.get("content-type")?.includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) throw new HttpError(400, "multipart 'file' field required");
      const [division] = await sql<{ slug: string }[]>`
        select slug from divisions where id = ${id}`;
      if (!division) throw new HttpError(404, "division not found");
      const preview = await createImport(auth, {
        filename: file.name,
        contentType: file.type || null,
        buffer: Buffer.from(await file.arrayBuffer()),
        pinDivision: { id, slug: division.slug },
      });
      return reply(201, preview);
    }
    const body = await parseBody(req, CreateEntrants);
    const rows = await createEntrants(auth, id, Array.isArray(body) ? body : [body]);
    return reply(201, Array.isArray(body) ? rows : rows[0]);
  });
}
