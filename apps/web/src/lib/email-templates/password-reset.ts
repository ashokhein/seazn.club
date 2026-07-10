import { button, linkFallback, paragraph, renderEmail } from "./compose";

/** Password-reset link (expires in 1 hour). */
export function passwordResetTemplate(link: string): { subject: string; html: string; text: string } {
  const subject = "Reset your Seazn Club password";
  return {
    subject,
    html: renderEmail({
      subject,
      preheader: "Your reset link is inside — it expires in 1 hour.",
      eyebrow: "Account",
      title: "Reset your password",
      contentHtml:
        paragraph(
          "We received a request to reset your Seazn Club password. This link expires in 1 hour.",
        ) +
        button("Reset password", link) +
        linkFallback(link),
      footerNote: "If you didn't request this, you can safely ignore this email.",
    }),
    text: `Reset your password (expires in 1 hour): ${link}`,
  };
}
