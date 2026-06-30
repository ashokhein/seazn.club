import { sql } from "@/lib/db";
import { requireOrgRole } from "@/lib/auth";
import { handler, HttpError } from "@/lib/http";
import { transferOwnerSchema } from "@/lib/types";

/**
 * Transfer org ownership to an existing member.
 * Current owner becomes admin; new owner gets 'owner' role.
 * Atomic — uses FOR UPDATE to prevent races.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handler(async () => {
    const { id } = await params;
    const { user } = await requireOrgRole(id, ["owner"]);
    const { new_owner_id } = transferOwnerSchema.parse(await req.json());

    if (new_owner_id === user.id) {
      throw new HttpError(400, "You are already the owner");
    }

    await sql.begin(async (tx) => {
      const [target] = await tx<{ role: string }[]>`
        select role from org_members
        where org_id = ${id} and user_id = ${new_owner_id}
        for update limit 1`;
      if (!target) throw new HttpError(404, "User is not a member of this organization");

      // Demote current owner to admin
      await tx`
        update org_members set role = 'admin'
        where org_id = ${id} and user_id = ${user.id}`;

      // Promote new owner
      await tx`
        update org_members set role = 'owner'
        where org_id = ${id} and user_id = ${new_owner_id}`;
    });

    return { ok: true };
  });
}
