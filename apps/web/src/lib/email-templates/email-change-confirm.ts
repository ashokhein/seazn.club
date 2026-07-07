import { btn, card } from "./shared";

/** Confirm-new-email link (expires in 24 hours). */
export function emailChangeConfirmTemplate(link: string): { subject: string; html: string; text: string } {
  return {
    subject: "Confirm your new email address — Seazn Club",
    html: card(
      "Confirm your new email address",
      "You requested a change to your email address. Click below to confirm. This link expires in 24 hours.",
      btn("Confirm new email", link),
      `If you didn't request this, ignore this email.<br>Or paste: ${link}`,
    ),
    text: `Confirm your new email address (expires in 24 hours): ${link}`,
  };
}
