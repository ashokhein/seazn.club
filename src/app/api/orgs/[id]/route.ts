import { sql } from "@/lib/db";
import { requireOrgRole } from "@/lib/auth";
import { handler } from "@/lib/http";
import { EDITOR_ROLES, renameOrgSchema, type Organization } from "@/lib/types";

/** Rename an organization (owners and admins). The slug is immutable. */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handler(async () => {
    const { id } = await params;
    await requireOrgRole(id, EDITOR_ROLES);
    const { name } = renameOrgSchema.parse(await req.json());
    const [org] = await sql<Organization[]>`
      update organizations set name = ${name}
      where id = ${id}
      returning id, name, slug, created_by, created_at`;
    if (!org) throw new Error("Organization not found");
    return org;
  });
}
