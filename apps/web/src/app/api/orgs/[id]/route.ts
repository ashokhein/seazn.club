import { sql } from "@/lib/db";
import { requireOrgRole } from "@/lib/auth";
import { handler } from "@/lib/http";
import { HttpError } from "@/lib/errors";
import { EDITOR_ROLES, renameOrgSchema, type Organization } from "@/lib/types";
import { z } from "zod";

const orgPatchSchema = z.union([
  renameOrgSchema,
  z.object({ logo_storage_path: z.string().max(500).nullable() }).strict(),
]);

/** Update an organization — rename or set branding logo (owners and admins). */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handler(async () => {
    const { id } = await params;
    await requireOrgRole(id, EDITOR_ROLES);
    const body = orgPatchSchema.parse(await req.json());

    const updates: Record<string, unknown> = {};
    if ("name" in body) updates.name = body.name;
    if ("logo_storage_path" in body) updates.logo_storage_path = body.logo_storage_path;

    if (Object.keys(updates).length === 0) throw new HttpError(400, "Nothing to update");

    const [org] = await sql<Organization[]>`
      update organizations set ${sql(updates)}
      where id = ${id}
      returning id, name, slug, created_by, created_at, logo_url, logo_storage_path`;
    if (!org) throw new HttpError(404, "Organization not found");
    return org;
  });
}
