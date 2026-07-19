import "server-only";
// Stripe Connect Express onboarding (doc 16 §1.1, PROMPT-20a): an org
// connects an Express account so entry fees settle to the CLUB, with the
// platform taking an application fee % (second revenue line). Only the
// onboarding state lives here; entry-fee checkout is in registrations.ts.
import type Stripe from "stripe";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { requireFeature } from "@/lib/entitlements";
import { getStripe } from "@/lib/stripe";
import type { AuthCtx } from "@/server/api-v1/auth";

export interface ConnectStatusRow {
  connected: boolean;
  charges_enabled: boolean;
  details_submitted: boolean | null;
  // Connect health mirror (P1-8): a verification lapse freezes payouts while
  // charges keep landing. Surfaced as an owner attention banner so the club
  // resumes onboarding before Stripe support has to explain the frozen payout.
  payouts_enabled: boolean;
  disabled_reason: string | null;
  requirements_due: number;
}

/** Billing surface — owner-only, session-only (matches /api/billing/*). */
function requireOwnerSession(auth: AuthCtx, orgId: string): void {
  if (auth.orgId !== orgId) throw new HttpError(403, "Wrong organization");
  if (auth.via !== "session" || auth.role !== "owner") {
    throw new HttpError(403, "Only the org owner can manage Stripe Connect");
  }
}

interface OrgConnectCols {
  stripe_account_id: string | null;
  stripe_charges_enabled: boolean;
  stripe_payouts_enabled: boolean;
  stripe_disabled_reason: string | null;
  stripe_requirements_due: number;
}

async function orgConnect(orgId: string): Promise<OrgConnectCols> {
  const [row] = await sql<OrgConnectCols[]>`
    select stripe_account_id, stripe_charges_enabled,
           stripe_payouts_enabled, stripe_disabled_reason, stripe_requirements_due
    from organizations where id = ${orgId}`;
  if (!row) throw new HttpError(404, "organization not found");
  return row;
}

/**
 * Connect status; `refresh` re-reads the account from Stripe so the
 * return-from-onboarding page shows live state even before the
 * account.updated webhook lands (reconcile-on-return, billing.ts pattern).
 */
export async function connectStatus(
  auth: AuthCtx,
  orgId: string,
  refresh = false,
): Promise<ConnectStatusRow> {
  requireOwnerSession(auth, orgId);
  let row = await orgConnect(orgId);
  let detailsSubmitted: boolean | null = null;
  if (row.stripe_account_id && refresh) {
    try {
      const account = await getStripe().accounts.retrieve(row.stripe_account_id);
      detailsSubmitted = account.details_submitted ?? null;
      await syncConnectAccount(account);
      row = await orgConnect(orgId);
    } catch {
      // Best-effort refresh; stored state still answers.
    }
  }
  return {
    connected: row.stripe_account_id !== null,
    charges_enabled: row.stripe_charges_enabled,
    details_submitted: detailsSubmitted,
    payouts_enabled: row.stripe_payouts_enabled,
    disabled_reason: row.stripe_disabled_reason,
    requirements_due: row.stripe_requirements_due,
  };
}

/**
 * Create (once) the Express account and mint an onboarding link. Gated on
 * `registration.paid` — Community orgs run free registration without Connect.
 */
export async function createConnectOnboardingLink(
  auth: AuthCtx,
  orgId: string,
  origin: string,
  returnPath: string,
  tosAgreed = false,
): Promise<{ url: string }> {
  requireOwnerSession(auth, orgId);
  // Connect is org-wide plumbing: any Event Pass in the org unlocks it too,
  // since the pass's competition is entitled to charge fees (v3/07 §3).
  const [anyPass] = await sql<{ ok: number }[]>`
    select 1 as ok from competition_passes where org_id = ${orgId} limit 1`;
  if (!anyPass) await requireFeature(orgId, "registration.paid");

  let { stripe_account_id: accountId } = await orgConnect(orgId);
  // ToS gate (PROMPT-55): the org accepts the entry-fee chargeback clause
  // (lost disputes are recovered from its connected balance) BEFORE the
  // Express account exists. Resuming onboarding never re-asks; the
  // acceptance timestamp lives on the account metadata — no DB column.
  // Checked before getStripe() so the 422 answers even keyless.
  if (!accountId && !tosAgreed) {
    throw new HttpError(
      422,
      "Agree to the Terms of Service (entry-fee chargebacks) before connecting Stripe",
    );
  }
  const stripe = getStripe();
  if (!accountId) {
    const account = await stripe.accounts.create({
      type: "express",
      metadata: { org_id: orgId, tos_agreed_at: new Date().toISOString() },
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
    });
    accountId = account.id;
    // First write wins: a concurrent onboarding click must not orphan an
    // account that Stripe already created for this org.
    const [claimed] = await sql<{ stripe_account_id: string }[]>`
      update organizations set stripe_account_id = ${accountId}
      where id = ${orgId} and stripe_account_id is null
      returning stripe_account_id`;
    if (!claimed) {
      ({ stripe_account_id: accountId } = await orgConnect(orgId));
      if (!accountId) throw new HttpError(500, "Failed to store the Connect account");
    }
  }

  const link = await stripe.accountLinks.create({
    account: accountId,
    type: "account_onboarding",
    refresh_url: `${origin}${returnPath}?connect=refresh`,
    return_url: `${origin}${returnPath}?connect=return`,
  });
  return { url: link.url };
}

/** Mirror Stripe's account flags (account.updated webhook + refresh path). */
export async function syncConnectAccount(account: Stripe.Account): Promise<void> {
  await sql`
    update organizations
    set stripe_charges_enabled  = ${account.charges_enabled === true},
        stripe_payouts_enabled  = ${account.payouts_enabled === true},
        stripe_disabled_reason  = ${account.requirements?.disabled_reason ?? null},
        stripe_requirements_due = ${account.requirements?.currently_due?.length ?? 0}
    where stripe_account_id = ${account.id}`;
}
