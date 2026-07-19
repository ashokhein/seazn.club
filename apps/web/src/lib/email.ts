import "server-only";
import { sql } from "@/lib/db";
import { getDictionary } from "@/lib/i18n";
import { type Locale } from "@/lib/i18n-constants";
import {
  verificationTemplate,
  passwordResetTemplate,
  magicLinkTemplate,
  emailChangeConfirmTemplate,
  emailChangeNoticeTemplate,
  accountDeletionTemplate,
  inviteTemplate,
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
  type SponsorDisputeLostArgs,
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

/** True when Resend is configured. */
export function emailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY);
}
