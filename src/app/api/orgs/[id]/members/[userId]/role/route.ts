import { sql } from "@/lib/db";
import { requireOrgRole } from "@/lib/auth";
import { handler } from "@/lib/http";
import { setRoleSchema } from "@/lib/types";

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

/** Change a member's role (owners only). Cannot demote the last owner. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; userId: string }> },
) {
  return handler(async () => {
    const { id, userId } = await params;
    await requireOrgRole(id, ["owner"]);
    const { role } = setRoleSchema.parse(await req.json());

    if (role !== "owner" && (await otherOwnerCount(id, userId)) === 0) {
      throw new Error("An organization must keep at least one owner");
    }

    const updated = await sql`
      update org_members set role = ${role}
      where org_id = ${id} and user_id = ${userId}
      returning user_id`;
    if (updated.length === 0) throw new Error("Member not found");
    return { ok: true };
  });
}
