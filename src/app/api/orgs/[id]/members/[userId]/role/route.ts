import { sql } from "@/lib/db";
import { requireOrgRole } from "@/lib/auth";
import { handler, HttpError } from "@/lib/http";
import { setRoleSchema } from "@/lib/types";

/** Change a member's role (owners only). Cannot demote the last owner. Transactional. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; userId: string }> },
) {
  return handler(async () => {
    const { id, userId } = await params;
    await requireOrgRole(id, ["owner"]);
    const { role } = setRoleSchema.parse(await req.json());

    await sql.begin(async (tx) => {
      const target = await tx<{ role: string }[]>`
        select role from org_members
        where org_id = ${id} and user_id = ${userId}
        for update limit 1`;
      if (!target[0]) throw new HttpError(404, "Member not found");

      if (target[0].role === "owner" && role !== "owner") {
        const [{ count }] = await tx<{ count: number }[]>`
          select count(*)::int as count from org_members
          where org_id = ${id} and role = 'owner' and user_id <> ${userId}
          for update`;
        if (count === 0)
          throw new HttpError(409, "An organization must keep at least one owner");
      }

      await tx`
        update org_members set role = ${role}
        where org_id = ${id} and user_id = ${userId}`;
    });

    return { ok: true };
  });
}
