import { btn, card } from "./shared";

/** Email-verification link sent at sign-up. */
export function verificationTemplate(link: string): { subject: string; html: string; text: string } {
  return {
    subject: "Verify your Seazn Club account",
    html: card(
      "Confirm your email",
      "Thanks for signing up. Click the button below to verify your email and finish setting up your account.",
      btn("Verify email", link),
      `Or paste this link into your browser:<br>${link}`,
    ),
    text: `Verify your account: ${link}`,
  };
}
