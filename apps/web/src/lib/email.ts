import "server-only";
import { sql } from "@/lib/db";
import { getDictionary } from "@/lib/i18n";
import { type Locale } from "@/lib/i18n-constants";
// Leaf module (imports nothing) — safe here even though ai-runs-admin.ts, the
// other consumer of the unit noun, imports this file.
import { aiRunUnitNoun } from "@/lib/ai-pricing";
import type { PassKey } from "@/lib/currency";
import {
  verificationTemplate,
  passwordResetTemplate,
  magicLinkTemplate,
  emailChangeConfirmTemplate,
  emailChangeNoticeTemplate,
  accountDeletionTemplate,
  inviteTemplate,
  transferOfferTemplate,
  transferCompleteTemplate,
  groupOrgRemovedTemplate,
  groupOrgLeftTemplate,
  registrationTemplate,
  type RegistrationEmailArgs,
  paymentReminderTemplate,
  type PaymentReminderArgs,
  registrationPromotedTemplate,
  type RegistrationPromotedArgs,
  refundIssuedTemplate,
  type RefundIssuedArgs,
  disputeAlertTemplate,
  type DisputeAlertArgs,
  disputeLostTemplate,
  type DisputeLostArgs,
  funnelClaimTemplate,
  funnelReminderTemplate,
  type FunnelEmailArgs,
  claimInviteTemplate,
  type ClaimInviteArgs,
  sponsorInvoiceTemplate,
  type SponsorInvoiceArgs,
  sponsorReceiptTemplate,
  type SponsorReceiptArgs,
  sponsorRefundTemplate,
  type SponsorRefundArgs,
  sponsorDisputeAlertTemplate,
  type SponsorDisputeAlertArgs,
  sponsorDisputeLostTemplate,
  sponsorDisputeWonTemplate,
  type SponsorDisputeLostArgs,
  type SponsorDisputeWonArgs,
  passRevokedTemplate,
  type PassRevokedArgs,
  staffDisputeAlertTemplate,
  type StaffDisputeAlertArgs,
  officialInviteTemplate,
  type OfficialInviteArgs,
  officialAssignedTemplate,
  type OfficialAssignedArgs,
  officialAssignmentChangedTemplate,
  type OfficialAssignmentChangedArgs,
  suspensionConfirmedTemplate,
  type SuspensionConfirmedArgs,
  suspensionServedTemplate,
  type SuspensionServedArgs,
  reportSubmittedTemplate,
  type ReportSubmittedArgs,
} from "@/lib/email-templates";
import { paragraph, panel, renderEmail } from "@/lib/email-templates/compose";
import { escapeHtml } from "@/lib/email-templates/shared";

const RESEND_ENDPOINT = "https://api.resend.com/emails";

function from(): string {
  return process.env.EMAIL_FROM || "Seazn Club <noreply@mail.seazn.club>";
}

function replyTo(): string | undefined {
  return process.env.EMAIL_REPLY_TO ?? undefined;
}

// ---------------------------------------------------------------------------
// Suppression list
// ---------------------------------------------------------------------------

/** Returns true if the address is on the suppression list. */
export async function isSuppressed(email: string): Promise<boolean> {
  const [row] = await sql<{ id: string }[]>`
    select id from email_suppressions where lower(email) = lower(${email}) limit 1`;
  return !!row;
}

/** Record a bounce or complaint so future sends are suppressed. */
export async function suppress(
  email: string,
  type: "bounce" | "complaint" | "manual",
  providerId?: string,
): Promise<void> {
  await sql`
    insert into email_suppressions (email, type, provider_id)
    values (${email}, ${type}, ${providerId ?? null})
    on conflict (email) do nothing`;
}

// ---------------------------------------------------------------------------
// Core send — never throws; returns true on provider acceptance.
// Checks suppression list for non-transactional mail (pass transactional=true
// to bypass the list for critical auth emails like password reset).
// ---------------------------------------------------------------------------

interface SendOptions {
  to: string;
  subject: string;
  html: string;
  text: string;
  transactional?: boolean; // true = bypass suppression check
}

async function send(opts: SendOptions): Promise<boolean> {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.warn(`[email] RESEND_API_KEY not set — would send "${opts.subject}" to ${opts.to}`);
    return false;
  }

  if (!opts.transactional) {
    const suppressed = await isSuppressed(opts.to).catch(() => false);
    if (suppressed) {
      console.warn(`[email] suppressed: ${opts.to}`);
      return false;
    }
  }

  try {
    const body: Record<string, unknown> = {
      from: from(),
      to: [opts.to],
      subject: opts.subject,
      html: opts.html,
      text: opts.text,
    };
    const rt = replyTo();
    if (rt) body.reply_to = rt;

    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(`[email] send failed (${res.status}) to ${opts.to}: ${detail}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[email] send error to ${opts.to}:`, err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Transactional emails (bypass suppression — user must receive these)
// ---------------------------------------------------------------------------

export async function sendVerificationEmail(
  to: string,
  link: string,
  locale: Locale = "en",
): Promise<boolean> {
  const dict = await getDictionary(locale, "emails");
  return send({ to, transactional: true, ...verificationTemplate(link, dict) });
}

export async function sendPasswordResetEmail(
  to: string,
  link: string,
  locale: Locale = "en",
): Promise<boolean> {
  const dict = await getDictionary(locale, "emails");
  return send({ to, transactional: true, ...passwordResetTemplate(link, dict) });
}

export async function sendMagicLinkEmail(
  to: string,
  link: string,
  locale: Locale = "en",
): Promise<boolean> {
  const dict = await getDictionary(locale, "emails");
  return send({ to, transactional: true, ...magicLinkTemplate(link, dict) });
}

/** Funnel claim link (v3/07 §6) — transactional: it doubles as sign-in. */
export async function sendFunnelClaimEmail(
  to: string,
  args: FunnelEmailArgs,
  locale: Locale = "en",
): Promise<boolean> {
  const dict = await getDictionary(locale, "emails");
  return send({ to, transactional: true, ...funnelClaimTemplate(args, dict) });
}

/** Player-account claim invite (PROMPT-53). */
export async function sendClaimInviteEmail(
  to: string,
  args: ClaimInviteArgs,
  locale: Locale = "en",
): Promise<boolean> {
  const dict = await getDictionary(locale, "emails");
  return send({ to, transactional: true, ...claimInviteTemplate(args, dict) });
}

/** Origin for officiating emails fired from request-less paths — same
 *  override order as the registration senders. */
function appOrigin(): string {
  return (
    process.env.OAUTH_BASE_URL ||
    process.env.NEXT_PUBLIC_BASE_URL ||
    "http://localhost:3000"
  ).replace(/\/$/, "");
}

/** Officiating claim invite (PROMPT-57) — same rail as sendClaimInviteEmail,
 *  officiating copy. Officials default to en (no stored locale). */
export async function sendOfficialInviteEmail(
  to: string,
  args: OfficialInviteArgs,
  locale: Locale = "en",
): Promise<boolean> {
  const dict = await getDictionary(locale, "emails");
  return send({ to, transactional: true, ...officialInviteTemplate(args, dict) });
}

/** New officiating assignment(s) with accept/decline CTA to /me. */
export async function sendOfficialAssignedEmail(
  to: string,
  args: Omit<OfficialAssignedArgs, "meUrl">,
  locale: Locale = "en",
): Promise<boolean> {
  const dict = await getDictionary(locale, "emails");
  return send({
    to,
    transactional: true,
    ...officialAssignedTemplate({ ...args, meUrl: `${appOrigin()}/me` }, dict),
  });
}

/** A match the official is assigned to changed time/venue. */
export async function sendOfficialAssignmentChangedEmail(
  to: string,
  args: Omit<OfficialAssignmentChangedArgs, "meUrl">,
  locale: Locale = "en",
): Promise<boolean> {
  const dict = await getDictionary(locale, "emails");
  return send({
    to,
    transactional: true,
    ...officialAssignmentChangedTemplate({ ...args, meUrl: `${appOrigin()}/me` }, dict),
  });
}

/** A confirmed suspension (SPEC-1) — CTA to the /me suspensions card. Claimed
 *  players default to their stored locale; unclaimed persons never reach here. */
export async function sendSuspensionConfirmedEmail(
  to: string,
  args: Omit<SuspensionConfirmedArgs, "meUrl">,
  locale: Locale = "en",
): Promise<boolean> {
  const dict = await getDictionary(locale, "emails");
  return send({
    to,
    transactional: true,
    ...suspensionConfirmedTemplate({ ...args, meUrl: `${appOrigin()}/me` }, dict),
  });
}

/** An official submitted a match report (SPEC-3) — sent to the org's
 *  owner/admins, deep-linked to the fixture's officials panel. `args` carries
 *  the org/competition/division slugs; the URL is built here. */
export async function sendReportSubmittedEmail(
  to: string,
  args: Omit<ReportSubmittedArgs, "url"> & {
    orgSlug: string;
    competitionSlug: string;
    divisionSlug: string;
  },
  locale: Locale = "en",
): Promise<boolean> {
  const dict = await getDictionary(locale, "emails");
  const { orgSlug, competitionSlug, divisionSlug, ...rest } = args;
  const url = `${appOrigin()}/o/${orgSlug}/c/${competitionSlug}/d/${divisionSlug}/schedule?tab=officials`;
  return send({
    to,
    transactional: true,
    ...reportSubmittedTemplate({ ...rest, url }, dict),
  });
}

/** A suspension flipped to served — the player is eligible again (SPEC-1). */
export async function sendSuspensionServedEmail(
  to: string,
  args: Omit<SuspensionServedArgs, "meUrl">,
  locale: Locale = "en",
): Promise<boolean> {
  const dict = await getDictionary(locale, "emails");
  return send({
    to,
    transactional: true,
    ...suspensionServedTemplate({ ...args, meUrl: `${appOrigin()}/me` }, dict),
  });
}

/** One-shot +24h funnel reminder (v3/07 §6). */
export async function sendFunnelReminderEmail(
  to: string,
  args: FunnelEmailArgs,
  locale: Locale = "en",
): Promise<boolean> {
  const dict = await getDictionary(locale, "emails");
  return send({ to, transactional: true, ...funnelReminderTemplate(args, dict) });
}

export async function sendEmailChangeConfirmation(
  to: string,
  link: string,
  locale: Locale = "en",
): Promise<boolean> {
  const dict = await getDictionary(locale, "emails");
  return send({ to, transactional: true, ...emailChangeConfirmTemplate(link, dict) });
}

export async function sendEmailChangeNotice(
  to: string,
  newEmail: string,
  locale: Locale = "en",
): Promise<boolean> {
  const dict = await getDictionary(locale, "emails");
  return send({ to, transactional: true, ...emailChangeNoticeTemplate(newEmail, dict) });
}

export async function sendAccountDeletionEmail(
  to: string,
  locale: Locale = "en",
): Promise<boolean> {
  const dict = await getDictionary(locale, "emails");
  return send({ to, transactional: true, ...accountDeletionTemplate(dict) });
}

// ---------------------------------------------------------------------------
// Lifecycle emails (respect suppression list)
// ---------------------------------------------------------------------------

export async function sendInviteEmail(
  to: string,
  orgName: string,
  link: string,
  locale: Locale = "en",
): Promise<boolean> {
  const dict = await getDictionary(locale, "emails");
  return send({ to, ...inviteTemplate(orgName, link, dict) });
}

/** A payer offered a whole billing group to this recipient (billing-group
 *  transfer). The recipient adds their own card to take it over; the link goes
 *  to the billing settings of an org they can reach in the group. */
export async function sendTransferOfferEmail(
  to: string,
  payerName: string,
  groupName: string,
  link: string,
  locale: Locale = "en",
): Promise<boolean> {
  const dict = await getDictionary(locale, "emails");
  return send({ to, ...transferOfferTemplate(payerName, groupName, link, dict) });
}

/** A payer handed a whole billing group to this recipient on the IMMEDIATE
 *  (community / no-live-subscription) path — the recipient accepted nothing and
 *  now simply pays for it. Informational; the link goes to the billing settings
 *  of an org they can reach in the group. Distinct from sendTransferOfferEmail. */
export async function sendTransferCompleteEmail(
  to: string,
  payerName: string,
  groupName: string,
  link: string,
  locale: Locale = "en",
): Promise<boolean> {
  const dict = await getDictionary(locale, "emails");
  return send({ to, ...transferCompleteTemplate(payerName, groupName, link, dict) });
}

/** A group's payer pushed an org off the shared bill (billing-group detach). The
 *  org's OWNER is told what happened — `ridesOutUntil` set = keeps the plan
 *  until then, null = on Community now — and that its billing is now theirs. */
export async function sendGroupOrgRemovedEmail(
  to: string,
  payerName: string,
  orgName: string,
  ridesOutUntil: string | null,
  link: string,
  locale: Locale = "en",
): Promise<boolean> {
  const dict = await getDictionary(locale, "emails");
  return send({ to, ...groupOrgRemovedTemplate(payerName, orgName, ridesOutUntil, link, dict) });
}

/** An org's own owner left a billing group (billing-group detach). The PAYER is
 *  told their bill changed — `seatFreed` true = the seat is a reusable freed
 *  slot (release), false = it left with the org and the next invoice is smaller. */
export async function sendGroupOrgLeftEmail(
  to: string,
  orgName: string,
  seatFreed: boolean,
  link: string,
  locale: Locale = "en",
): Promise<boolean> {
  const dict = await getDictionary(locale, "emails");
  return send({ to, ...groupOrgLeftTemplate(orgName, seatFreed, link, dict) });
}

export interface RegistrationEmail extends RegistrationEmailArgs {
  to: string;
  /** Recipient locale for the email copy; defaults to English. */
  locale?: Locale;
}

/** Registration confirmation — carries the offline (cash/bank) payment
 *  instructions for paid entries. */
export async function sendRegistrationEmail(opts: RegistrationEmail): Promise<boolean> {
  const { to, locale = "en", ...args } = opts;
  const dict = await getDictionary(locale, "emails");
  return send({ to, ...registrationTemplate(args, dict) });
}

export interface PaymentReminderEmail extends PaymentReminderArgs {
  to: string;
  locale?: Locale;
}

/** Payment reminder for an unpaid entry fee (offline nudge or card T-24h). */
export async function sendPaymentReminderEmail(opts: PaymentReminderEmail): Promise<boolean> {
  const { to, locale = "en", ...args } = opts;
  const dict = await getDictionary(locale, "emails");
  return send({ to, ...paymentReminderTemplate(args, dict) });
}

export interface RegistrationPromotedEmail extends RegistrationPromotedArgs {
  to: string;
  locale?: Locale;
}

/** Waitlist promotion (spec §2): spot opened — pay window / instructions. */
export async function sendRegistrationPromotedEmail(
  opts: RegistrationPromotedEmail,
): Promise<boolean> {
  const { to, locale = "en", ...args } = opts;
  const dict = await getDictionary(locale, "emails");
  return send({ to, ...registrationPromotedTemplate(args, dict) });
}

export interface RefundIssuedEmail extends RefundIssuedArgs {
  to: string;
  locale?: Locale;
}

/** Registrant receipt for any refund (auto, manual, late, duplicate). */
export async function sendRefundIssuedEmail(opts: RefundIssuedEmail): Promise<boolean> {
  const { to, locale = "en", ...args } = opts;
  const dict = await getDictionary(locale, "emails");
  return send({ to, ...refundIssuedTemplate(args, dict) });
}

export interface DisputeAlertEmail extends DisputeAlertArgs {
  to: string;
  locale?: Locale;
}

/** Organiser alert: an entry-fee payment was disputed (spec issue #5). */
export async function sendDisputeAlertEmail(opts: DisputeAlertEmail): Promise<boolean> {
  const { to, locale = "en", ...args } = opts;
  const dict = await getDictionary(locale, "emails");
  return send({ to, ...disputeAlertTemplate(args, dict) });
}

export interface DisputeLostEmail extends DisputeLostArgs {
  to: string;
  locale?: Locale;
}

/** Organiser outcome mail: a chargeback closed lost — states the write-off
 *  and the balance recovery (PROMPT-55). */
export async function sendDisputeLostEmail(opts: DisputeLostEmail): Promise<boolean> {
  const { to, locale = "en", ...args } = opts;
  const dict = await getDictionary(locale, "emails");
  return send({ to, ...disputeLostTemplate(args, dict) });
}

export interface SponsorInvoiceEmail extends SponsorInvoiceArgs {
  to: string;
  locale?: Locale;
}

/** Pay-now invoice to the sponsor contact at checkout start (v10). */
export async function sendSponsorInvoiceEmail(opts: SponsorInvoiceEmail): Promise<boolean> {
  const { to, locale = "en", ...args } = opts;
  const dict = await getDictionary(locale, "emails");
  return send({ to, ...sponsorInvoiceTemplate(args, dict) });
}

export interface SponsorReceiptEmail extends SponsorReceiptArgs {
  to: string;
  locale?: Locale;
}

/** Receipt to the sponsor once the order is paid and the placement is live. */
export async function sendSponsorReceiptEmail(opts: SponsorReceiptEmail): Promise<boolean> {
  const { to, locale = "en", ...args } = opts;
  const dict = await getDictionary(locale, "emails");
  return send({ to, ...sponsorReceiptTemplate(args, dict) });
}

export interface SponsorRefundEmail extends SponsorRefundArgs {
  to: string;
  locale?: Locale;
}

/** Refund notice to the sponsor when a paid order is refunded. */
export async function sendSponsorRefundEmail(opts: SponsorRefundEmail): Promise<boolean> {
  const { to, locale = "en", ...args } = opts;
  const dict = await getDictionary(locale, "emails");
  return send({ to, ...sponsorRefundTemplate(args, dict) });
}

export interface SponsorDisputeAlertEmail extends SponsorDisputeAlertArgs {
  to: string;
  locale?: Locale;
}

/** Organiser alert: a sponsorship package payment was disputed (P0-2). */
export async function sendSponsorDisputeAlertEmail(
  opts: SponsorDisputeAlertEmail,
): Promise<boolean> {
  const { to, locale = "en", ...args } = opts;
  const dict = await getDictionary(locale, "emails");
  return send({ to, ...sponsorDisputeAlertTemplate(args, dict) });
}

export interface SponsorDisputeLostEmail extends SponsorDisputeLostArgs {
  to: string;
  locale?: Locale;
}

/** Organiser outcome mail: a sponsorship chargeback closed lost — states the
 *  write-off and the balance recovery (P0-2). */
export async function sendSponsorDisputeLostEmail(
  opts: SponsorDisputeLostEmail,
): Promise<boolean> {
  const { to, locale = "en", ...args } = opts;
  const dict = await getDictionary(locale, "emails");
  return send({ to, ...sponsorDisputeLostTemplate(args, dict) });
}

export interface SponsorDisputeWonEmail extends SponsorDisputeWonArgs {
  to: string;
  locale?: Locale;
}

/** Organiser outcome mail: a sponsorship chargeback closed WON — the money
 *  stays and the placement is restored (the lost mail's happy twin). */
export async function sendSponsorDisputeWonEmail(
  opts: SponsorDisputeWonEmail,
): Promise<boolean> {
  const { to, locale = "en", ...args } = opts;
  const dict = await getDictionary(locale, "emails");
  return send({ to, ...sponsorDisputeWonTemplate(args, dict) });
}

export interface PassRevokedEmail extends PassRevokedArgs {
  to: string;
  locale?: Locale;
}

/** Owner notice when an Event Pass is refunded (P0-3a): the pass is revoked and
 *  the competition returns to the plan's active-competition allowance. */
export async function sendPassRevokedEmail(opts: PassRevokedEmail): Promise<boolean> {
  const { to, locale = "en", ...args } = opts;
  const dict = await getDictionary(locale, "emails");
  return send({ to, ...passRevokedTemplate(args, dict) });
}

export interface StaffDisputeAlertEmail extends StaffDisputeAlertArgs {
  to: string;
  locale?: Locale;
}

/** Internal staff alert (payments-hardening Task 7): a PLATFORM charge — a
 *  subscription invoice or an Event Pass — was disputed. Transactional: staff
 *  must always receive it (bypasses the suppression list); the platform locale
 *  is en. */
export async function sendStaffDisputeAlertEmail(
  opts: StaffDisputeAlertEmail,
): Promise<boolean> {
  const { to, locale = "en", ...args } = opts;
  const dict = await getDictionary(locale, "emails");
  return send({ to, transactional: true, ...staffDisputeAlertTemplate(args, dict) });
}

export interface StuckEventsAlertEmail {
  to: string;
  /** The Stripe event id (e.g. evt_…) that could not be auto-replayed. */
  eventId: string;
  eventType: string;
  /** How many auto-replay attempts were made before parking it. */
  attempts: number;
}

/** Internal staff alert (payments-hardening Task 11, P1-7): a webhook event
 *  failed auto-replay `attempts` times and is now PARKED — the sweep caps
 *  attempts and never re-selects it, so a human must inspect and replay it from
 *  /admin/billing-events. Fires exactly once per event. Platform-locale (en)
 *  and built inline — this is an ops-only alert with no user-facing i18n.
 *  Transactional so it bypasses the suppression list. */
export async function sendStuckEventsAlertEmail(opts: StuckEventsAlertEmail): Promise<boolean> {
  const subject = `Stuck webhook event needs review: ${opts.eventId}`;
  const bodyText =
    `Stripe event ${opts.eventId} (${opts.eventType}) failed auto-replay ${opts.attempts} times ` +
    `and is now parked. Inspect and replay it manually from /admin/billing-events.`;
  const html = renderEmail({
    subject,
    preheader: `${opts.eventType} parked after ${opts.attempts} attempts`,
    eyebrow: "Billing · Webhooks",
    title: "Stuck webhook event",
    contentHtml:
      paragraph(escapeHtml(bodyText)) +
      panel("Event", `${opts.eventId}\n${opts.eventType}\nattempts: ${opts.attempts}`),
    footerNote: "Automated staff alert — webhook auto-replay cron (P1-7).",
  });
  const text = `${bodyText}\n\nEvent: ${opts.eventId} (${opts.eventType}) · attempts ${opts.attempts}`;
  return send({ to: opts.to, transactional: true, subject, html, text });
}

export interface CreditPackGrantFailedAlertEmail {
  to: string;
  sessionId: string;
  orgId: string;
  packKey?: string;
  reason: string;
}

/** Internal staff alert (P3 T1 review fix): a PAID `credit_pack` checkout
 *  session arrived with no usable credit-amount snapshot in its metadata (a
 *  pre-fix session, corrupt metadata, or a `pack_key` the catalog fallback
 *  also could not resolve) — the buyer paid but the wallet grant could not be
 *  safely determined, so nothing was granted rather than risking a silent
 *  wrong amount. A human must inspect and grant manually. Built inline, no
 *  user-facing i18n — same ops-only pattern as `sendStuckEventsAlertEmail`. */
export async function sendCreditPackGrantFailedAlertEmail(
  opts: CreditPackGrantFailedAlertEmail,
): Promise<boolean> {
  const subject = `Credit pack purchase could not be granted: ${opts.sessionId}`;
  const bodyText =
    `A paid credit-pack checkout session (${opts.sessionId}, org ${opts.orgId}` +
    `${opts.packKey ? `, pack_key ${opts.packKey}` : ""}) could not be granted: ${opts.reason}. ` +
    `The buyer was charged but no wallet credits have been granted yet — inspect and grant manually.`;
  const html = renderEmail({
    subject,
    preheader: `Paid credit pack ungranted — org ${opts.orgId}`,
    eyebrow: "Billing · Credit packs",
    title: "Credit pack grant failed",
    contentHtml:
      paragraph(escapeHtml(bodyText)) +
      panel(
        "Session",
        `${opts.sessionId}\norg: ${opts.orgId}${opts.packKey ? `\npack_key: ${opts.packKey}` : ""}\nreason: ${opts.reason}`,
      ),
    footerNote: "Automated staff alert — credit pack webhook (P3 T1).",
  });
  const text = `${bodyText}\n\nSession: ${opts.sessionId} · org ${opts.orgId} · reason: ${opts.reason}`;
  return send({ to: opts.to, transactional: true, subject, html, text });
}

export interface SizePackGrantFailedAlertEmail {
  to: string;
  sessionId: string;
  targetOrgId: string;
  competitionId?: string;
  sizePackKey?: string;
  reason: string;
}

/** Internal staff alert (v17 Phase 3 Task 3b): a PAID `size_pack` checkout
 *  session arrived with no usable feature_key/delta_each snapshot in its
 *  metadata, and the catalog fallback could not resolve one either — the buyer
 *  paid but the cap-lift could not be safely determined, so nothing was granted
 *  rather than risking a wrong lift. A human must inspect and grant manually.
 *  Ops-only, no user-facing i18n (mirrors sendCreditPackGrantFailedAlertEmail). */
export async function sendSizePackGrantFailedAlertEmail(
  opts: SizePackGrantFailedAlertEmail,
): Promise<boolean> {
  const subject = `Size pack purchase could not be granted: ${opts.sessionId}`;
  const bodyText =
    `A paid size-pack checkout session (${opts.sessionId}, org ${opts.targetOrgId}` +
    `${opts.competitionId ? `, competition ${opts.competitionId}` : ""}` +
    `${opts.sizePackKey ? `, size_pack_key ${opts.sizePackKey}` : ""}) could not be granted: ` +
    `${opts.reason}. The buyer was charged but no entrant-cap add-on has been granted yet — ` +
    `inspect and grant manually.`;
  const html = renderEmail({
    subject,
    preheader: `Paid size pack ungranted — org ${opts.targetOrgId}`,
    eyebrow: "Billing · Size packs",
    title: "Size pack grant failed",
    contentHtml:
      paragraph(escapeHtml(bodyText)) +
      panel(
        "Session",
        `${opts.sessionId}\norg: ${opts.targetOrgId}` +
          `${opts.competitionId ? `\ncompetition: ${opts.competitionId}` : ""}` +
          `${opts.sizePackKey ? `\nsize_pack_key: ${opts.sizePackKey}` : ""}\nreason: ${opts.reason}`,
      ),
    footerNote: "Automated staff alert — size pack webhook (P3 T3b).",
  });
  const text = `${bodyText}\n\nSession: ${opts.sessionId} · org ${opts.targetOrgId} · reason: ${opts.reason}`;
  return send({ to: opts.to, transactional: true, subject, html, text });
}

export interface PassCreditReversalIncompleteAlertEmail {
  to: string;
  orgId: string;
  orgName: string;
  competitionName: string;
  /** WHICH Event Pass rung earned the credit being reversed (v17 #294). Every
   *  sentence below said "An Event Pass credit for …", so whoever triages a $59
   *  Event Pass L reversal went looking for a $29 charge. */
  passKey: PassKey;
  /** What the original pass credit granted, in minor units. */
  grantedMinor: number;
  /** What was actually reversed on refund, in minor units — capped so the
   *  customer is never pushed into debt (design 2026-07-26 §5). 0 when
   *  `reason` is "undetermined": nothing was reversed at all. */
  reversedMinor: number;
  currency: string;
  /**
   * "consumed" — the unreversed portion was provably drawn down by an
   * invoice; the numbers above are exact and nothing further can be done.
   * "undetermined" — some OTHER credit source (e.g. a plan-downgrade
   * proration credit) touched the customer's balance pool after this pass's
   * credit was granted. `customer.balance` has no per-transaction
   * attribution, so there is no safe way to compute what belongs to this
   * pass — nothing was automatically reversed, and a human must read the
   * Stripe balance transaction history directly.
   */
  reason: "consumed" | "undetermined";
}

/** Internal staff alert (design 2026-07-26 §5, `reversePassCreditOnRefund`):
 *  an Event Pass was refunded but its pass-to-Pro subscription credit could
 *  not be fully (or, in the "undetermined" case, at all) reversed. A human
 *  needs the exact numbers and the reason, not just "something is off".
 *  Ops-only, no user-facing i18n (mirrors sendCreditPackGrantFailedAlertEmail). */
export async function sendPassCreditReversalIncompleteAlertEmail(
  opts: PassCreditReversalIncompleteAlertEmail,
): Promise<boolean> {
  const absorbed = opts.grantedMinor - opts.reversedMinor;
  const undetermined = opts.reason === "undetermined";
  // Ops-only copy, so this is not translated — but it must still name the rung,
  // and both branches build their own sentence, so both carry it.
  const rung = opts.passKey === "event_pass_l" ? "Event Pass L" : "Event Pass M";
  const subject = undetermined
    ? `Pass credit reversal skipped — needs manual review — org ${opts.orgId}`
    : `Pass credit reversal incomplete — org ${opts.orgId}`;
  const bodyText = undetermined
    ? `An ${rung} credit for "${opts.competitionName}" (org ${opts.orgName}, ${opts.orgId}) was ` +
      `refunded, but other balance activity (for example, a plan-downgrade proration credit) was ` +
      `detected on the customer since the ${opts.grantedMinor} ${opts.currency} credit was granted. ` +
      `Stripe's customer balance is a single pool with no per-transaction attribution, so which part ` +
      `of the current balance belongs to this pass cannot be determined safely — nothing was ` +
      `automatically reversed. Review the customer's balance transaction history in Stripe directly. ` +
      `Note that the billing group's one lifetime Event Pass credit is now BLOCKED by this ` +
      `unresolved record: it still holds the lifetime cap, so no org in this group can earn ` +
      `another pass credit. Settling the customer's balance in Stripe does NOT release it, and there is no ` +
      `self-serve way to clear it yet — staff resolution tooling is planned.`
    : `An ${rung} credit for "${opts.competitionName}" (org ${opts.orgName}, ${opts.orgId}) was ` +
      `refunded. ${opts.grantedMinor} ${opts.currency} was originally granted; only ` +
      `${opts.reversedMinor} ${opts.currency} of unspent credit could be reversed. The remaining ` +
      `${absorbed} ${opts.currency} was already consumed by an invoice and is written off, not ` +
      `recovered — the customer is never pushed into debt.`;
  const html = renderEmail({
    subject,
    preheader: undetermined
      ? `Manual review needed — org ${opts.orgName}`
      : `${absorbed} ${opts.currency} absorbed — org ${opts.orgName}`,
    eyebrow: `Billing · ${rung}`,
    title: undetermined ? "Pass credit reversal skipped" : "Pass credit reversal incomplete",
    contentHtml:
      paragraph(escapeHtml(bodyText)) +
      panel(
        "Reversal",
        `org: ${opts.orgName} (${opts.orgId})\ncompetition: ${opts.competitionName}\n` +
          `rung: ${rung}\n` +
          `granted: ${opts.grantedMinor} ${opts.currency}\n` +
          `reversed: ${opts.reversedMinor} ${opts.currency}\n` +
          (undetermined
            ? `reason: other balance activity detected — needs manual review\n` +
              `group lifetime pass credit: BLOCKED until this record is resolved`
            : `absorbed: ${absorbed} ${opts.currency}`),
      ),
    footerNote: "Automated staff alert — pass credit refund webhook (design 2026-07-26 §5).",
  });
  const text =
    `${bodyText}\n\norg: ${opts.orgName} (${opts.orgId}) · competition: ${opts.competitionName} · ` +
    `granted ${opts.grantedMinor} ${opts.currency} · reversed ${opts.reversedMinor} ${opts.currency}` +
    (undetermined ? "" : ` · absorbed ${absorbed} ${opts.currency}`);
  return send({ to: opts.to, transactional: true, subject, html, text });
}

export interface AiRunCostAlertEmail {
  to: string;
  orgId: string;
  competitionId?: string;
  phase: "schedule" | "officials";
  model: string;
  costUsd: number;
  medianUsd: number;
  /** Trailing window the median was computed over — supplied by the caller
   *  (`MEDIAN_WINDOW_DAYS`) so the copy can never drift from the query. */
  windowDays: number;
  /** Requested run mode, `schedule` phase only (`generate` / `regenerate` /
   *  `repair` …) — the officials path has no mode concept, so this is absent
   *  there rather than a placeholder. Named in the copy because a full
   *  regenerate and a nudge are different cost classes; the MEDIAN it is
   *  compared against stays pooled across modes (v17 gap #295 — mode-scoped
   *  baselines wait on calibration data), which the copy says out loud. */
  mode?: string | null;
  /** `pack_units` as stamped on the run's own ledger row — the run's size.
   *  NULLABLE on purpose: every event written before this wave carries no such
   *  key, so the copy omits the size clause rather than printing a `0` that
   *  would read as a real, empty pack. The unit differs per phase — see
   *  `AI_RUN_UNIT_NOUN`. */
  packUnits?: number | null;
}

/** Internal staff alert (v17 gap #295): a single AI run's cost landed at or
 *  above AI_RUN_COST_ALERT_MULTIPLE x the trailing median for its
 *  phase — the exact trigger SPEC-2 §5.1 named for revisiting the flat
 *  1-credit-per-run price. Ops-only, no user-facing i18n (mirrors
 *  sendStuckEventsAlertEmail). Not deduped — a run class that keeps tripping
 *  this is the point, not a bug to suppress. */
export async function sendAiRunCostAlertEmail(opts: AiRunCostAlertEmail): Promise<boolean> {
  const multiple = opts.medianUsd > 0 ? opts.costUsd / opts.medianUsd : null;
  const subject = `Expensive AI run: $${opts.costUsd.toFixed(4)} (org ${opts.orgId})`;
  // Size clause. `packUnits` is nullable (pre-wave rows have no such key), and
  // 0 is a REAL measurement (a pack with nothing movable) — so absence drops
  // the clause entirely while zero is reported, and only the per-unit ratio is
  // suppressed. The noun is phase-specific: schedule counts movable fixtures,
  // officials counts every fixture in the pack.
  const units = opts.packUnits ?? null;
  const sizeText = units == null ? "" : ` over ${units} ${aiRunUnitNoun(opts.phase, units)}`;
  const perUnit = units != null && units > 0 ? opts.costUsd / units : null;
  const perUnitText =
    perUnit == null ? "" : ` That is $${perUnit.toFixed(4)} per ${aiRunUnitNoun(opts.phase, 1)}` +
      // The officials denominator is knowingly incomplete: cost scales with the
      // roster the model has to reason over as well as the fixture count, and
      // pack.officials.length is deliberately not stamped. Say so, or a reader
      // will compare $/fixture across officials runs as if it were like-for-like.
      (opts.phase === "officials" ? " (officials cost also scales with roster size, which is not stamped)." : ".");
  const bodyText =
    `A ${opts.phase} AI run${opts.mode ? ` (mode: ${opts.mode})` : ""} for org ${opts.orgId}` +
    `${opts.competitionId ? ` (competition ${opts.competitionId})` : ""}${sizeText} cost $${opts.costUsd.toFixed(4)} on ` +
    `${opts.model}${multiple ? `, ${multiple.toFixed(1)}x the trailing ${opts.windowDays}-day ${opts.phase} median ($${opts.medianUsd.toFixed(4)})` : ""}.` +
    `${perUnitText}` +
    ` That baseline is pooled across every mode and pack size — mode-scoped medians and` +
    ` size-weighted credit pricing both wait on calibration data (v17 gap #295).`;
  const html = renderEmail({
    subject,
    preheader: `${opts.phase} run — org ${opts.orgId}`,
    eyebrow: "AI credits · Margin",
    title: "Expensive AI run",
    contentHtml:
      paragraph(escapeHtml(bodyText)) +
      panel(
        "Run",
        `org: ${opts.orgId}${opts.competitionId ? `\ncompetition: ${opts.competitionId}` : ""}\n` +
          `phase: ${opts.phase}${opts.mode ? `\nmode: ${opts.mode}` : ""}\n` +
          // Spelled out rather than omitted: "no size on this row" is itself
          // information (it dates the row to before the pack_units stamp).
          `size: ${units == null ? "not recorded" : `${units} ${aiRunUnitNoun(opts.phase, units)}`}\n` +
          `model: ${opts.model}\ncost: $${opts.costUsd.toFixed(4)}\n` +
          `median: $${opts.medianUsd.toFixed(4)}`,
      ),
    footerNote: "Automated staff alert — AI run cost check (v17 gap #295).",
  });
  const text =
    `${bodyText}\n\norg: ${opts.orgId} · phase: ${opts.phase} · model: ${opts.model} · ` +
    `cost $${opts.costUsd.toFixed(4)} · median $${opts.medianUsd.toFixed(4)}`;
  return send({ to: opts.to, transactional: true, subject, html, text });
}

export interface EarnGrantVolumeAlertEmail {
  to: string;
  count: number;
  threshold: number;
}

/** Internal staff alert (v17 gap #296 farm-watch): today's earn_grant ledger
 *  rows (onboarding + referral-welcome + referral + first_paid, pooled
 *  across every wallet) crossed the daily alert threshold — the backstop
 *  for the publish-with-division gate, in case the gate itself is being
 *  worked (many throwaway orgs each publishing one bare competition).
 *  Ops-only, no user-facing i18n (mirrors sendStuckEventsAlertEmail). Fires
 *  at most once per cron poll, not deduped across days — a persistent high
 *  day repeats the alert, which is the point. */
export async function sendEarnGrantVolumeAlertEmail(opts: EarnGrantVolumeAlertEmail): Promise<boolean> {
  const subject = `Earn-grant volume alert: ${opts.count} today (threshold ${opts.threshold})`;
  const bodyText =
    `${opts.count} earn_grant credit rows have landed today, at or above the alert threshold of ` +
    `${opts.threshold} (v17 gap #296 farm-watch — onboarding/referral-welcome earn grants gated on a ` +
    `published competition with a division). Check /admin/revenue for the AI credit margin panel and ` +
    `recent signups sharing an IP or email domain pattern; farmed accounts spend differently from real ` +
    `ones (immediately, on large runs, then never again).`;
  const html = renderEmail({
    subject,
    preheader: `${opts.count} earn grants today`,
    eyebrow: "Credits · Growth loop",
    title: "Earn-grant volume alert",
    contentHtml:
      paragraph(escapeHtml(bodyText)) +
      panel("Today", `earn_grant rows: ${opts.count}\nthreshold: ${opts.threshold}`),
    footerNote: "Automated staff alert — daily billing-grant cron (v17 gap #296).",
  });
  const text = `${bodyText}\n\nearn_grant rows today: ${opts.count} · threshold: ${opts.threshold}`;
  return send({ to: opts.to, transactional: true, subject, html, text });
}

export interface ExtraOrgAllowanceAlertEmail {
  to: string;
  /** The billing GROUP (subscriptions.id) — the thing that holds the orgs. */
  subscriptionId: string;
  /** The org whose payer made the purchase; the entry point for a sales
   *  conversation, not the scope of the allowance (which is group-wide). */
  orgId: string;
  planKey: string;
  /** The plan's own `orgs.max_owned` from plan_entitlements (pro 5 /
   *  pro_plus 10 today) — READ, never assumed, so the copy cannot drift from
   *  the seed. */
  baseCap: number;
  extraOrgs: number;
  previousExtraOrgs: number;
  /** baseCap + extraOrgs — what actually crossed the threshold. */
  totalAllowance: number;
  threshold: number;
}

/** Internal staff alert (v17 gap #293): a billing group just BOUGHT its way to
 *  `threshold` or more total organisations. Deliberately not a block — the
 *  self-serve cap (MAX_EXTRA_ORGS) is far higher and stays an abuse bound, not
 *  a sales signal. V314's `orgs.max_owned` seed recorded the intent that a
 *  group at this size "becomes an enterprise conversation rather than a silent
 *  reseller"; this is that conversation being started while the customer is
 *  actively expanding, instead of a sweep noticing weeks later.
 *  Ops-only, no user-facing i18n (mirrors sendEarnGrantVolumeAlertEmail). Not
 *  deduped: a group that keeps adding organisations is exactly the one to keep
 *  hearing about. */
export async function sendExtraOrgAllowanceAlertEmail(
  opts: ExtraOrgAllowanceAlertEmail,
): Promise<boolean> {
  const subject = `Large billing group: ${opts.totalAllowance} organisations (group ${opts.subscriptionId})`;
  const bodyText =
    `A ${opts.planKey} billing group just raised its extra-organisation add-on from ` +
    `${opts.previousExtraOrgs} to ${opts.extraOrgs}, taking its total organisation allowance to ` +
    `${opts.totalAllowance} (plan base ${opts.baseCap} + ${opts.extraOrgs} purchased), at or above the ` +
    `alert threshold of ${opts.threshold}. The purchase was NOT blocked — this is a sales prompt, not a ` +
    `guard. A group this size is an enterprise conversation: check whether a negotiated plan serves them ` +
    `better than a growing per-organisation rider, and whether the organisations look like one federation ` +
    `or like resale.`;
  const html = renderEmail({
    subject,
    preheader: `${opts.totalAllowance} organisations · ${opts.planKey}`,
    eyebrow: "Billing · Growth",
    title: "Large billing group",
    contentHtml:
      paragraph(escapeHtml(bodyText)) +
      panel(
        "Group",
        `billing group: ${opts.subscriptionId}\norg (purchaser's active): ${opts.orgId}\n` +
          `plan: ${opts.planKey}\nplan base cap: ${opts.baseCap}\n` +
          `extra organisations: ${opts.previousExtraOrgs} -> ${opts.extraOrgs}\n` +
          `total allowance: ${opts.totalAllowance}\nthreshold: ${opts.threshold}`,
      ),
    footerNote: "Automated staff alert — extra-organisation purchase (v17 gap #293).",
  });
  const text =
    `${bodyText}\n\nbilling group: ${opts.subscriptionId} · plan: ${opts.planKey} · ` +
    `base ${opts.baseCap} + ${opts.extraOrgs} extra = ${opts.totalAllowance} (threshold ${opts.threshold})`;
  return send({ to: opts.to, transactional: true, subject, html, text });
}

/** True when Resend is configured. */
export function emailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY);
}
