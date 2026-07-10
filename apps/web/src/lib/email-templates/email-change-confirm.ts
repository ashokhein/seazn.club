import { button, linkFallback, paragraph, renderEmail } from "./compose";

/** Confirm-new-email link (expires in 24 hours). */
export function emailChangeConfirmTemplate(link: string): { subject: string; html: string; text: string } {
  const subject = "Confirm your new email address — Seazn Club";
  return {
    subject,
    html: renderEmail({
      subject,
      preheader: "Confirm this address to complete your email change — expires in 24 hours.",
      eyebrow: "Account",
      title: "Confirm your new email",
      contentHtml:
        paragraph(
          "You requested a change to your email address. Click below to confirm. This link expires in 24 hours.",
        ) +
        button("Confirm new email", link) +
        linkFallback(link),
      footerNote: "If you didn't request this, you can safely ignore this email.",
    }),
    text: `Confirm your new email address (expires in 24 hours): ${link}`,
  };
}
