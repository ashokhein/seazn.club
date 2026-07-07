import "server-only";
import { sql } from "@/lib/db";
import {
  verificationTemplate,
  passwordResetTemplate,
  emailChangeConfirmTemplate,
  emailChangeNoticeTemplate,
  accountDeletionTemplate,
  inviteTemplate,
  registrationTemplate,
  type RegistrationEmailArgs,
  paymentReminderTemplate,
  type PaymentReminderArgs,
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

/** Organiser-triggered payment reminder for an unpaid offline entry fee. */
export async function sendPaymentReminderEmail(opts: PaymentReminderEmail): Promise<boolean> {
  const { to, ...args } = opts;
  return send({ to, ...paymentReminderTemplate(args) });
}

/** True when Resend is configured. */
export function emailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY);
}
