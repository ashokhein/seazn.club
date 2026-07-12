import { sql } from "@/lib/db";
import {
  requireUser,
  resolveActiveOrg,
  destroySession,
  invalidateUser,
  invalidateUserOrgs,
} from "@/lib/auth";
import { handler, HttpError } from "@/lib/http";
import { deleteAccountSchema, updateProfileSchema } from "@/lib/types";
import { sendAccountDeletionEmail } from "@/lib/email";

/**
 * Whoami (task-8): resolves the same identity AnalyticsBootstrap used to read
 * via getCurrentUser()/cookies() directly in the ROOT layout — moved here so
 * that read no longer forces every route rendered through the root layout to
 * go dynamic whenever NEXT_PUBLIC_POSTHOG_KEY is set. The client-side
 * analytics bootstrap fetches this once (sessionStorage-memoized) instead.
 * 401 for anonymous callers; org is null for a user with no org membership.
 */
export async function GET() {
  return handler(async () => {
    const user = await requireUser();
    const org = await resolveActiveOrg(user);
    if (!org) return { id: user.id, email: user.email, org: null };

    const [sub] = await sql<{ plan_key: string | null }[]>`
      select coalesce(plan_key, 'community') as plan_key
      from subscriptions where org_id = ${org.id}`;
    return {
      id: user.id,
      email: user.email,
      org: { id: org.id, name: org.name, plan: sub?.plan_key ?? "community" },
    };
  });
}

/** Update the authenticated user's profile (currently just the display name). */
export async function PATCH(req: Request) {
  return handler(async () => {
    const user = await requireUser();
    const { display_name } = updateProfileSchema.parse(await req.json());

    const [row] = await sql<{ display_name: string }[]>`
      update users set display_name = ${display_name}
      where id = ${user.id}
      returning display_name`;

    // display_name is cached in getCurrentUser — drop the stale entry.
    await invalidateUser(user.id);
    return { display_name: row.display_name };
  });
}

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
