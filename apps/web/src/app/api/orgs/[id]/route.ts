import { sql } from "@/lib/db";
import { requireOrgRole, invalidateUserOrgs, generateOrgSlug } from "@/lib/auth";
import { recordSlugHistory } from "@/server/usecases/slugs";
import { invalidateSlugCache } from "@/server/slug-resolve";
import { fireOrgRevalidate } from "@/server/public-site/revalidate";
import { handler } from "@/lib/http";
import { HttpError } from "@/lib/errors";
import { mergeBrandColor, mergeSponsors } from "@/lib/org-branding";
import { EDITOR_ROLES, renameOrgSchema, type Organization } from "@/lib/types";
import { z } from "zod";

const orgPatchSchema = z.union([
  renameOrgSchema,
  z.object({ logo_storage_path: z.string().max(500).nullable() }).strict(),
  z.object({ payment_instructions: z.string().max(2000).nullable() }).strict(),
  // Org "about" (v3/06 §2): Markdown, rendered on the public org page.
  z.object({ about: z.string().max(20_000).nullable() }).strict(),
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
  // Sponsor slots (v3/10 #5): rendered on the public dashboard footer, the
  // registration masthead and the slideshow. Reads are branding-gated.
  z.object({
    sponsors: z
      .array(
        z.object({
          name: z.string().min(1).max(80),
          url: z.string().url().max(500).nullish(),
          logo: z.string().max(500).nullish(),
        }),
      )
      .max(12),
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
    let previousSlug: string | null = null;
    if ("name" in body) {
      updates.name = body.name;
      // Rename regenerates the slug (v3/01 §2, PROMPT-30); the old slug keeps
      // redirecting via slug_history so shared /o and /shared links survive.
      const [current] = await sql<{ name: string; slug: string }[]>`
        select name, slug from organizations where id = ${id}`;
      if (!current) throw new HttpError(404, "Organization not found");
      if (body.name !== current.name) {
        const next = await generateOrgSlug(body.name, id);
        if (next !== current.slug) {
          updates.slug = next;
          previousSlug = current.slug;
        }
      }
    }
    if ("logo_storage_path" in body) updates.logo_storage_path = body.logo_storage_path;
    if ("payment_instructions" in body) updates.payment_instructions = body.payment_instructions;
    if ("about" in body) updates.about = body.about;
    // Branding writes MERGE into the blob (lib/org-branding): colors and
    // sponsors share the column, and neither may clobber the other.
    if ("branding" in body || "sponsors" in body) {
      const [current] = await sql<{ branding: unknown }[]>`
        select branding from organizations where id = ${id}`;
      if (!current) throw new HttpError(404, "Organization not found");
      const merged =
        "branding" in body
          ? mergeBrandColor(current.branding, body.branding.colors.primary)
          : mergeSponsors(current.branding, body.sponsors);
      updates.branding = sql.json(merged as never);
    }

    if (Object.keys(updates).length === 0) throw new HttpError(400, "Nothing to update");

    const org = await sql.begin(async (tx) => {
      const [row] = await tx<Organization[]>`
        update organizations set ${tx(updates)}
        where id = ${id}
        returning id, name, slug, created_by, created_at, logo_url, logo_storage_path, payment_instructions, branding`;
      if (!row) throw new HttpError(404, "Organization not found");
      if (previousSlug) await recordSlugHistory(tx, "org", null, previousSlug, id);
      return row;
    });

    // name/logo/payment appear in every member's cached org list — bust each.
    const members = await sql<{ user_id: string }[]>`
      select user_id from org_members where org_id = ${id}`;
    await Promise.all(members.map((m) => invalidateUserOrgs(m.user_id)));
    // …and on the public masthead (name, logo, brand color) — bust the tree.
    // A rename busts the OLD slug's tree too (its pages now redirect).
    fireOrgRevalidate(org.slug);
    if (previousSlug) fireOrgRevalidate(previousSlug);
    if (previousSlug) await invalidateSlugCache("org", null, previousSlug, org.slug);

    return org;
  });
}
