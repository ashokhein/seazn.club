import "server-only";

const RESEND_ENDPOINT = "https://api.resend.com/emails";

/** True when Resend is configured (an API key is present). */
export function emailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY);
}

/**
 * Send the account verification email via Resend. Delivery is best-effort and
 * never throws: the account + token already exist, and login re-sends the
 * link, so a transient/config delivery error must not block sign-up. Returns
 * true when the email was accepted by the provider.
 */
export async function sendVerificationEmail(
  to: string,
  link: string,
): Promise<boolean> {
  const key = process.env.RESEND_API_KEY;
  const from =
    process.env.EMAIL_FROM || "S.A.F.E Tournaments <onboarding@resend.dev>";

  if (!key) {
    console.warn(`[email] RESEND_API_KEY not set — verification link for ${to}: ${link}`);
    return false;
  }

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject: "Verify your S.A.F.E Tournaments account",
        html: verificationHtml(link),
        text: `Verify your account by opening this link: ${link}`,
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(`[email] verification send failed (${res.status}) ${detail}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[email] verification send error", err);
    return false;
  }
}

function verificationHtml(link: string): string {
  return `
  <div style="font-family:system-ui,Segoe UI,Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto">
    <h2 style="color:#6b21a8">Confirm your email</h2>
    <p style="color:#334155">Thanks for signing up. Click the button below to verify your email and finish setting up your account.</p>
    <p style="margin:24px 0">
      <a href="${link}" style="background:#7c3aed;color:#fff;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:600">Verify email</a>
    </p>
    <p style="color:#94a3b8;font-size:12px">Or paste this link into your browser:<br>${link}</p>
  </div>`;
}
