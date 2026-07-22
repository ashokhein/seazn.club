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
import { cancelBillingGroup } from "@/lib/billing";
import { groupIdsOwnedBy } from "@/lib/billing-group";
import { toLocale } from "@/lib/i18n";

/**
 * Whoami (task-8): resolves the same identity AnalyticsBootstrap used to read
 * via getCurrentUser()/cookies() directly in the ROOT layout — moved here so
 * that read no longer forces every route rendered through the root layout to
 * go dynamic whenever NEXT_PUBLIC_POSTHOG_KEY is set. The client-side
 * analytics bootstrap (lib/analytics-identity) fetches this per navigation
 * until identified (sessionStorage-memoized). 401 for anonymous callers; org
 * is null for a user with no org membership. Payload is minimized to what
 * the identify call consumes — no email (task-8 review F3).
 */
export async function GET() {
  const res = await handler(async () => {
    const user = await requireUser();
    const org = await resolveActiveOrg(user);
    if (!org) return { id: user.id, org: null };

    const [sub] = await sql<{ plan_key: string | null }[]>`
      select coalesce(s.plan_key, 'community') as plan_key
      from subscriptions s
      join organizations o on o.subscription_id = s.id
      where o.id = ${org.id}`;
    return {
      id: user.id,
      org: { id: org.id, name: org.name, plan: sub?.plan_key ?? "community" },
    };
  });
  // Identity endpoints must never be cacheable — set explicitly on EVERY
  // status (200 and 401 alike), not left to framework defaults + external
  // CDN rules (task-8 review F3).
  res.headers.set("Cache-Control", "private, no-store");
  return res;
}

/**
 * Update the authenticated user's profile: display name and/or timezone. Each
 * field is optional; an absent field is left untouched, a `timezone: null`
 * clears the preference ("follow my browser"). The zone is validated in the
 * schema (isValidIana) so the column only holds an Intl-parseable name.
 */
export async function PATCH(req: Request) {
  return handler(async () => {
    const user = await requireUser();
    const patch = updateProfileSchema.parse(await req.json());

    const [row] = await sql<{ display_name: string; timezone: string | null; locale: string | null }[]>`
      update users set
        display_name = ${patch.display_name ?? sql`display_name`},
        timezone     = ${patch.timezone !== undefined ? patch.timezone : sql`timezone`},
        locale       = ${patch.locale !== undefined ? patch.locale : sql`locale`}
      where id = ${user.id}
      returning display_name, timezone, locale`;

    // display_name/timezone/locale are cached in getCurrentUser — drop the stale entry.
    await invalidateUser(user.id);
    return { display_name: row.display_name, timezone: row.timezone, locale: row.locale };
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

    // Hand on (or shut down) every billing group this user PAYS for, before
    // org_members is emptied below — the heir is found through it.
    //
    // Since V310 billing gates on subscriptions.owner_user_id, so a group left
    // pointing at a deleted user is unmanageable by anyone: every billing route
    // 403s, nobody can cancel, and the card keeps being charged for ever. The
    // sole-owner 409 above does not cover this — an association can pay for
    // member clubs it is not a member of, so it owns groups it owns no orgs in.
    for (const subscriptionId of await groupIdsOwnedBy(user.id)) {
      // Oldest owner of any LIVE org in the group, other than the leaver.
      const [heir] = await sql<{ user_id: string }[]>`
        select m.user_id from org_members m
        join organizations o on o.id = m.org_id
        where o.subscription_id = ${subscriptionId}
          and o.deleted_at is null
          and m.role = 'owner'
          and m.user_id <> ${user.id}
        order by m.created_at, m.user_id
        limit 1`;
      if (heir) {
        await sql`
          update subscriptions set owner_user_id = ${heir.user_id}, updated_at = now()
          where id = ${subscriptionId}`;
      } else if (!(await cancelBillingGroup(subscriptionId))) {
        // Nobody left who could ever manage it — cancel rather than orphan.
        //
        // And STOP if that cancel did not happen. cancelBillingGroup returns
        // false without writing anything local when Stripe refuses, which
        // leaves the subscription live and still charging; carrying on would
        // anonymise and soft-delete this user a few lines below, after which
        // `owner_user_id` points at a deleted user, every billing route 403s
        // and nobody can ever cancel it. Nothing sweeps it up either —
        // reconcileGroupQuantities selects on `quantity_paid <> live org
        // count`, which this group satisfies perfectly well.
        //
        // Deletion is the irreversible half, so it is the half that yields:
        // fail loudly while the user still has an account (and a support path)
        // rather than destroy their data into a subscription that outlives
        // them. Retrying the same request once Stripe is reachable completes
        // the deletion — every step above it is idempotent.
        throw new HttpError(
          503,
          "We could not cancel your subscription just now, so your account has not been deleted — it would have kept being charged with nobody able to stop it. Please try again in a few minutes.",
        );
      }
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
    await sendAccountDeletionEmail(user.email, toLocale(user.locale));
    await destroySession();

    return { ok: true };
  });
}
