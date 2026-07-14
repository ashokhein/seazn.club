import "server-only";
import { sql } from "@/lib/db";
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
} from "@/lib/email-templates";

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

export async function sendVerificationEmail(to: string, link: string): Promise<boolean> {
  return send({ to, transactional: true, ...verificationTemplate(link) });
}

export async function sendPasswordResetEmail(to: string, link: string): Promise<boolean> {
  return send({ to, transactional: true, ...passwordResetTemplate(link) });
}

export async function sendMagicLinkEmail(to: string, link: string): Promise<boolean> {
  return send({ to, transactional: true, ...magicLinkTemplate(link) });
}

/** Funnel claim link (v3/07 §6) — transactional: it doubles as sign-in. */
export async function sendFunnelClaimEmail(to: string, args: FunnelEmailArgs): Promise<boolean> {
  return send({ to, transactional: true, ...funnelClaimTemplate(args) });
}

/** Player-account claim invite (PROMPT-53). */
export async function sendClaimInviteEmail(to: string, args: ClaimInviteArgs): Promise<boolean> {
  return send({ to, transactional: true, ...claimInviteTemplate(args) });
}

/** One-shot +24h funnel reminder (v3/07 §6). */
export async function sendFunnelReminderEmail(
  to: string,
  args: FunnelEmailArgs,
): Promise<boolean> {
  return send({ to, transactional: true, ...funnelReminderTemplate(args) });
}

export async function sendEmailChangeConfirmation(to: string, link: string): Promise<boolean> {
  return send({ to, transactional: true, ...emailChangeConfirmTemplate(link) });
}

export async function sendEmailChangeNotice(to: string, newEmail: string): Promise<boolean> {
  return send({ to, transactional: true, ...emailChangeNoticeTemplate(newEmail) });
}

export async function sendAccountDeletionEmail(to: string): Promise<boolean> {
  return send({ to, transactional: true, ...accountDeletionTemplate() });
}

// ---------------------------------------------------------------------------
// Lifecycle emails (respect suppression list)
// ---------------------------------------------------------------------------

export async function sendInviteEmail(
  to: string,
  orgName: string,
  link: string,
): Promise<boolean> {
  return send({ to, ...inviteTemplate(orgName, link) });
}

export interface RegistrationEmail extends RegistrationEmailArgs {
  to: string;
}

/** Registration confirmation — carries the offline (cash/bank) payment
 *  instructions for paid entries. */
export async function sendRegistrationEmail(opts: RegistrationEmail): Promise<boolean> {
  const { to, ...args } = opts;
  return send({ to, ...registrationTemplate(args) });
}

export interface PaymentReminderEmail extends PaymentReminderArgs {
  to: string;
}

/** Payment reminder for an unpaid entry fee (offline nudge or card T-24h). */
export async function sendPaymentReminderEmail(opts: PaymentReminderEmail): Promise<boolean> {
  const { to, ...args } = opts;
  return send({ to, ...paymentReminderTemplate(args) });
}

export interface RegistrationPromotedEmail extends RegistrationPromotedArgs {
  to: string;
}

/** Waitlist promotion (spec §2): spot opened — pay window / instructions. */
export async function sendRegistrationPromotedEmail(
  opts: RegistrationPromotedEmail,
): Promise<boolean> {
  const { to, ...args } = opts;
  return send({ to, ...registrationPromotedTemplate(args) });
}

export interface RefundIssuedEmail extends RefundIssuedArgs {
  to: string;
}

/** Registrant receipt for any refund (auto, manual, late, duplicate). */
export async function sendRefundIssuedEmail(opts: RefundIssuedEmail): Promise<boolean> {
  const { to, ...args } = opts;
  return send({ to, ...refundIssuedTemplate(args) });
}

export interface DisputeAlertEmail extends DisputeAlertArgs {
  to: string;
}

/** Organiser alert: an entry-fee payment was disputed (spec issue #5). */
export async function sendDisputeAlertEmail(opts: DisputeAlertEmail): Promise<boolean> {
  const { to, ...args } = opts;
  return send({ to, ...disputeAlertTemplate(args) });
}

export interface DisputeLostEmail extends DisputeLostArgs {
  to: string;
}

/** Organiser outcome mail: a chargeback closed lost — states the write-off
 *  and the balance recovery (PROMPT-55). */
export async function sendDisputeLostEmail(opts: DisputeLostEmail): Promise<boolean> {
  const { to, ...args } = opts;
  return send({ to, ...disputeLostTemplate(args) });
}

/** True when Resend is configured. */
export function emailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY);
}
