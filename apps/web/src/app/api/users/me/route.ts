import { sql } from "@/lib/db";
import { requireUser, destroySession, invalidateUser, invalidateUserOrgs } from "@/lib/auth";
import { handler, HttpError } from "@/lib/http";
import { deleteAccountSchema } from "@/lib/types";
import { sendAccountDeletionEmail } from "@/lib/email";

/**
 * Soft-delete the authenticated user's account.
 * Blocked if the user is the sole owner of any org that has other members.
 * Caller must pass { confirm: "DELETE" } to prevent accidental deletion.
 */
export async function DELETE(req: Request) {
  return handler(async () => {
    const user = await requireUser();
    deleteAccountSchema.parse(await req.json());

    // Block if sole owner of any org with other members
    const blockedOrgs = await sql<{ name: string }[]>`
      select o.name from organizations o
      join org_members m on m.org_id = o.id and m.user_id = ${user.id} and m.role = 'owner'
      where (
        select count(*) from org_members m2
        where m2.org_id = o.id and m2.role = 'owner' and m2.user_id <> ${user.id}
      ) = 0
      and (
        select count(*) from org_members m3
        where m3.org_id = o.id and m3.user_id <> ${user.id}
      ) > 0`;

    if (blockedOrgs.length > 0) {
      const names = blockedOrgs.map((o) => `"${o.name}"`).join(", ");
      throw new HttpError(
        409,
        `You are the sole owner of ${names}. Transfer ownership or remove all other members before deleting your account.`,
      );
    }

    const purgeAfter = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const anonEmail = `deleted-${user.id}@deleted.invalid`;

    await sql.begin(async (tx) => {
      // Remove from all orgs they were sole owner of (no other members — safe to dissolve)
      await tx`
        delete from org_members where user_id = ${user.id}`;

      // Soft-delete: anonymize PII, mark deleted, schedule purge
      await tx`
        update users set
          email         = ${anonEmail},
          password_hash = null,
          display_name  = 'Deleted User',
          google_sub    = null,
          avatar_url    = null,
          deleted_at    = now(),
          purge_after   = ${purgeAfter.toISOString()}
        where id = ${user.id}`;
    });

    await invalidateUser(user.id);
    await invalidateUserOrgs(user.id);

    // Best-effort notification before destroying session
    await sendAccountDeletionEmail(user.email);
    await destroySession();

    return { ok: true };
  });
}
