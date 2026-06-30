import { handler } from "@/lib/http";
import { HttpError } from "@/lib/errors";
import { requireOrgRole } from "@/lib/auth";
import { sql } from "@/lib/db";
import { z } from "zod";

const patchSchema = z.object({ is_public: z.boolean() }).strict();

function generateSlug(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  const suffix = Math.random().toString(36).slice(2, 7);
  return `${base}-${suffix}`;
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handler(async () => {
    const { id } = await params;
    const [t] = await sql<{ org_id: string; name: string; public_slug: string | null }[]>`
      select org_id, name, public_slug from tournaments where id = ${id}`;
    if (!t) throw new HttpError(404, "Tournament not found");

    await requireOrgRole(t.org_id, ["owner", "admin"]);

    const { is_public } = patchSchema.parse(await req.json());

    // Generate a slug the first time we make it public
    let slug = t.public_slug;
    if (is_public && !slug) {
      // Retry up to 5 times on collision (extremely unlikely)
      for (let i = 0; i < 5; i++) {
        slug = generateSlug(t.name);
        const [existing] = await sql`
          select id from tournaments where public_slug = ${slug} limit 1`;
        if (!existing) break;
      }
    }

    await sql`
      update tournaments
      set is_public = ${is_public}, public_slug = ${slug ?? null}
      where id = ${id}`;

    return { is_public, public_slug: slug };
  });
}
