import { sql } from "@/lib/db";
import { requireUser, getOrgRole } from "@/lib/auth";
import { handler, HttpError } from "@/lib/http";

/**
 * Leave an organization. Blocked if the caller is the sole owner.
 * Any member can call this on themselves.
 */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handler(async () => {
    const { id } = await params;
    const user = await requireUser();

    const role = await getOrgRole(id, user.id);
    if (!role) throw new HttpError(404, "You are not a member of this organization");

    await sql.begin(async (tx) => {
      if (role === "owner") {
        const [{ count }] = await tx<{ count: number }[]>`
          select count(*)::int as count from org_members
          where org_id = ${id} and role = 'owner' and user_id <> ${user.id}
          for update`;
        if (count === 0) {
          throw new HttpError(
            409,
            "You are the sole owner. Transfer ownership before leaving, or delete the organization.",
          );
        }
      }

      await tx`delete from org_members where org_id = ${id} and user_id = ${user.id}`;
    });

    return { ok: true };
  });
}
