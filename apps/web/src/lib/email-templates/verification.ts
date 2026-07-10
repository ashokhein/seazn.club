import { button, linkFallback, paragraph, renderEmail } from "./compose";

/** Email-verification link sent at sign-up. */
export function verificationTemplate(link: string): { subject: string; html: string; text: string } {
  const subject = "Verify your Seazn Club account";
  return {
    subject,
    html: renderEmail({
      subject,
      preheader: "One click to verify your email and finish setting up your account.",
      eyebrow: "Account",
      title: "Confirm your email",
      contentHtml:
        paragraph(
          "Thanks for signing up. Click the button below to verify your email and finish setting up your account.",
        ) +
        button("Verify email", link) +
        linkFallback(link),
      footerNote: "You received this because this address was used to sign up for Seazn Club.",
    }),
    text: `Verify your account: ${link}`,
  };
}
