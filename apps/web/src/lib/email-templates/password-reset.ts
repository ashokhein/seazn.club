import { btn, card } from "./shared";

/** Password-reset link (expires in 1 hour). */
export function passwordResetTemplate(link: string): { subject: string; html: string; text: string } {
  return {
    subject: "Reset your Seazn Club password",
    html: card(
      "Reset your password",
      "We received a request to reset your Seazn Club password. This link expires in 1 hour.",
      btn("Reset password", link),
      `If you didn't request this, ignore this email.<br>Or paste: ${link}`,
    ),
    text: `Reset your password (expires in 1 hour): ${link}`,
  };
}
