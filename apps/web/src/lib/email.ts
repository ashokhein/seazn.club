import "server-only";
import { sql } from "@/lib/db";

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
  return send({
    to, transactional: true,
    subject: "Verify your Seazn Club account",
    html: verificationHtml(link),
    text: `Verify your account: ${link}`,
  });
}

export async function sendPasswordResetEmail(to: string, link: string): Promise<boolean> {
  return send({
    to, transactional: true,
    subject: "Reset your Seazn Club password",
    html: passwordResetHtml(link),
    text: `Reset your password (expires in 1 hour): ${link}`,
  });
}

export async function sendEmailChangeConfirmation(to: string, link: string): Promise<boolean> {
  return send({
    to, transactional: true,
    subject: "Confirm your new email address — Seazn Club",
    html: emailChangeConfirmHtml(link),
    text: `Confirm your new email address (expires in 24 hours): ${link}`,
  });
}

export async function sendEmailChangeNotice(to: string, newEmail: string): Promise<boolean> {
  return send({
    to, transactional: true,
    subject: "Your Seazn Club email address is being changed",
    html: emailChangeNoticeHtml(newEmail),
    text: `Your account email is being changed to ${newEmail}. If this wasn't you, contact support.`,
  });
}

export async function sendAccountDeletionEmail(to: string): Promise<boolean> {
  return send({
    to, transactional: true,
    subject: "Your Seazn Club account has been deleted",
    html: accountDeletionHtml(),
    text: "Your Seazn Club account has been deleted. Data will be erased within 30 days.",
  });
}

// ---------------------------------------------------------------------------
// Lifecycle emails (respect suppression list)
// ---------------------------------------------------------------------------

export async function sendInviteEmail(
  to: string,
  orgName: string,
  link: string,
): Promise<boolean> {
  return send({
    to,
    subject: `You've been invited to join ${orgName} on Seazn Club`,
    html: inviteHtml(orgName, link),
    text: `You've been invited to join ${orgName}. Accept: ${link}`,
  });
}

/** True when Resend is configured. */
export function emailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY);
}

// ---------------------------------------------------------------------------
// HTML templates
// ---------------------------------------------------------------------------

function verificationHtml(link: string): string {
  return card(
    "Confirm your email",
    "Thanks for signing up. Click the button below to verify your email and finish setting up your account.",
    btn("Verify email", link),
    `Or paste this link into your browser:<br>${link}`,
  );
}

function passwordResetHtml(link: string): string {
  return card(
    "Reset your password",
    "We received a request to reset your Seazn Club password. This link expires in 1 hour.",
    btn("Reset password", link),
    `If you didn't request this, ignore this email.<br>Or paste: ${link}`,
  );
}

function emailChangeConfirmHtml(link: string): string {
  return card(
    "Confirm your new email address",
    "You requested a change to your email address. Click below to confirm. This link expires in 24 hours.",
    btn("Confirm new email", link),
    `If you didn't request this, ignore this email.<br>Or paste: ${link}`,
  );
}

function emailChangeNoticeHtml(newEmail: string): string {
  return card(
    "Your email address is being changed",
    `Someone requested a change to the email address on your account to <strong>${newEmail}</strong>. The change will take effect once the new address is confirmed. If this wasn't you, contact support immediately.`,
    "",
    "",
  );
}

function accountDeletionHtml(): string {
  return card(
    "Your account has been deleted",
    "Your Seazn Club account and associated data have been scheduled for permanent deletion within 30 days. If this wasn't you, contact support immediately.",
    "",
    "",
  );
}

function inviteHtml(orgName: string, link: string): string {
  return card(
    `You've been invited to ${orgName}`,
    `You've been invited to join <strong>${orgName}</strong> on Seazn Club. Click below to accept.`,
    btn("Accept invite", link),
    `Or paste: ${link}`,
  );
}

// Shared layout helpers
function btn(label: string, href: string): string {
  return `<p style="margin:24px 0"><a href="${href}" style="background:#7c3aed;color:#fff;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:600">${label}</a></p>`;
}

function card(title: string, body: string, cta: string, footer: string): string {
  return `<div style="font-family:system-ui,Segoe UI,Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto">
  <h2 style="color:#6b21a8">${title}</h2>
  <p style="color:#334155">${body}</p>
  ${cta}
  ${footer ? `<p style="color:#94a3b8;font-size:12px">${footer}</p>` : ""}
</div>`;
}
