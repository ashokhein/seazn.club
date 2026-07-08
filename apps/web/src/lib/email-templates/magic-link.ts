import { btn, card } from "./shared";

/** Passwordless sign-in link (expires in 15 minutes). */
export function magicLinkTemplate(link: string): { subject: string; html: string; text: string } {
  return {
    subject: "Your Seazn Club sign-in link",
    html: card(
      "Sign in to Seazn Club",
      "Click the button below to sign in. This link expires in 15 minutes and can be used once.",
      btn("Sign in", link),
      `If you didn't request this, ignore this email.<br>Or paste: ${link}`,
    ),
    text: `Sign in to Seazn Club (expires in 15 minutes): ${link}`,
  };
}
