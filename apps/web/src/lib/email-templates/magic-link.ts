import { button, linkFallback, paragraph, renderEmail } from "./compose";

/** Passwordless sign-in link (expires in 15 minutes). */
export function magicLinkTemplate(link: string): { subject: string; html: string; text: string } {
  const subject = "Your Seazn Club sign-in link";
  return {
    subject,
    html: renderEmail({
      subject,
      preheader: "Your one-time sign-in link — expires in 15 minutes.",
      eyebrow: "Account",
      title: "Sign in to Seazn Club",
      contentHtml:
        paragraph(
          "Click the button below to sign in. This link expires in 15 minutes and can be used once.",
        ) +
        button("Sign in", link) +
        linkFallback(link),
      footerNote: "If you didn't request this, you can safely ignore this email.",
    }),
    text: `Sign in to Seazn Club (expires in 15 minutes): ${link}`,
  };
}
