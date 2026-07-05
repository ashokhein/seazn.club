import { sql } from "@/lib/db";
import { requireOrgRole } from "@/lib/auth";
import { handler, HttpError, PaymentRequiredError } from "@/lib/http";
import { getLimit } from "@/lib/entitlements";
import { setRoleSchema } from "@/lib/types";

/**
 * Change a member's role (owners only). Cannot demote the last owner.
 * Seat quotas (doc 13 §5) bite on pool changes too: scorer→member consumes a
 * members.max seat, member→scorer a scorers.max seat — counted in the same tx.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; userId: string }> },
) {
  return handler(async () => {
    const { id, userId } = await params;
    await requireOrgRole(id, ["owner"]);
    const { role } = setRoleSchema.parse(await req.json());

    // Resolve the destination pool's limit before the tx (cached read).
    const quotaKey = role === "scorer" ? "scorers.max" : "members.max";
    const limit = await getLimit(id, quotaKey);

    await sql.begin(async (tx) => {
      // Serialise seat/role changes per org, then count without FOR UPDATE
      // (aggregates cannot be row-locked).
      await tx`select 1 from organizations where id = ${id} for update`;
      const target = await tx<{ role: string }[]>`
        select role from org_members
        where org_id = ${id} and user_id = ${userId}
        for update limit 1`;
      if (!target[0]) throw new HttpError(404, "Member not found");

      if (target[0].role === "owner" && role !== "owner") {
        const [{ count }] = await tx<{ count: number }[]>`
          select count(*)::int as count from org_members
          where org_id = ${id} and role = 'owner' and user_id <> ${userId}`;
        if (count === 0)
          throw new HttpError(409, "An organization must keep at least one owner");
      }

      // Pool switch: check the destination seat pool (doc 13 §5).
      const wasScorer = target[0].role === "scorer";
      const willBeScorer = role === "scorer";
      if (wasScorer !== willBeScorer && limit !== null) {
        const [{ n }] = willBeScorer
          ? await tx<{ n: number }[]>`
              select count(*)::int as n from org_members
              where org_id = ${id} and role = 'scorer'`
          : await tx<{ n: number }[]>`
              select count(*)::int as n from org_members
              where org_id = ${id} and role <> 'scorer' and user_id <> ${userId}`;
        if (n + 1 > limit) throw new PaymentRequiredError(quotaKey);
      }

      await tx`
        update org_members set role = ${role}
        where org_id = ${id} and user_id = ${userId}`;
    });

    return { ok: true };
  });
}
