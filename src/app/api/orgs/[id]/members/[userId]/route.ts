import { sql } from "@/lib/db";
import { requireOrgRole } from "@/lib/auth";
import { handler } from "@/lib/http";

/** Count remaining owners if `excludeUserId`'s ownership were removed. */
async function otherOwnerCount(
  orgId: string,
  excludeUserId: string,
): Promise<number> {
  const [{ count }] = await sql<{ count: number }[]>`
    select count(*)::int as count from org_members
    where org_id = ${orgId} and role = 'owner' and user_id <> ${excludeUserId}`;
  return count;
}

/** Remove a member (owners only). Cannot remove the last owner. */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string; userId: string }> },
) {
  return handler(async () => {
    const { id, userId } = await params;
    await requireOrgRole(id, ["owner"]);

    const target = await sql<{ role: string }[]>`
      select role from org_members
      where org_id = ${id} and user_id = ${userId} limit 1`;
    if (!target[0]) throw new Error("Member not found");
    if (target[0].role === "owner" && (await otherOwnerCount(id, userId)) === 0) {
      throw new Error("An organization must keep at least one owner");
    }

    await sql`
      delete from org_members where org_id = ${id} and user_id = ${userId}`;
    return { ok: true };
  });
}
