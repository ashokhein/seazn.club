import { sql } from "@/lib/db";
import { requireOrgRole, invalidateUserOrgs } from "@/lib/auth";
import { fireOrgRevalidate } from "@/server/public-site/revalidate";
import { handler } from "@/lib/http";
import { HttpError } from "@/lib/errors";
import { EDITOR_ROLES, renameOrgSchema, type Organization } from "@/lib/types";
import { z } from "zod";

const orgPatchSchema = z.union([
  renameOrgSchema,
  z.object({ logo_storage_path: z.string().max(500).nullable() }).strict(),
  z.object({ payment_instructions: z.string().max(2000).nullable() }).strict(),
  // Brand color ({ colors: { primary } }, same shape as competitions.branding).
  // primary: null clears back to the platform default. Writes are accepted on
  // any plan — reads are gated by dashboard.branding, like competitions.
  z.object({
    branding: z.object({
      colors: z.object({
        primary: z.string().regex(/^#[0-9a-f]{6}$/i).nullable(),
      }).strict(),
    }).strict(),
  }).strict(),
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
    if ("payment_instructions" in body) updates.payment_instructions = body.payment_instructions;
    if ("branding" in body) {
      updates.branding = sql.json(
        body.branding.colors.primary === null
          ? {}
          : { colors: { primary: body.branding.colors.primary.toLowerCase() } },
      );
    }

    if (Object.keys(updates).length === 0) throw new HttpError(400, "Nothing to update");

    const [org] = await sql<Organization[]>`
      update organizations set ${sql(updates)}
      where id = ${id}
      returning id, name, slug, created_by, created_at, logo_url, logo_storage_path, payment_instructions, branding`;
    if (!org) throw new HttpError(404, "Organization not found");

    // name/logo/payment appear in every member's cached org list — bust each.
    const members = await sql<{ user_id: string }[]>`
      select user_id from org_members where org_id = ${id}`;
    await Promise.all(members.map((m) => invalidateUserOrgs(m.user_id)));
    // …and on the public masthead (name, logo, brand color) — bust the tree.
    fireOrgRevalidate(org.slug);

    return org;
  });
}
