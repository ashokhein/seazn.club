import { sql } from "@/lib/db";
import { requireOrgRole, invalidateUserOrgs } from "@/lib/auth";
import { handler, HttpError } from "@/lib/http";

/** Remove a member (owners only). Cannot remove the last owner. Transactional. */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string; userId: string }> },
) {
  return handler(async () => {
    const { id, userId } = await params;
    await requireOrgRole(id, ["owner"]);

    await sql.begin(async (tx) => {
      const target = await tx<{ role: string }[]>`
        select role from org_members
        where org_id = ${id} and user_id = ${userId}
        for update limit 1`;
      if (!target[0]) throw new HttpError(404, "Member not found");

      if (target[0].role === "owner") {
        // Aggregates cannot carry FOR UPDATE (latent bug — Postgres rejects
        // it); the member row lock above serialises the check enough.
        const [{ count }] = await tx<{ count: number }[]>`
          select count(*)::int as count from org_members
          where org_id = ${id} and role = 'owner' and user_id <> ${userId}`;
        if (count === 0)
          throw new HttpError(409, "An organization must keep at least one owner");
      }

      await tx`delete from org_members where org_id = ${id} and user_id = ${userId}`;
    });
    await invalidateUserOrgs(userId);

    return { ok: true };
  });
}
