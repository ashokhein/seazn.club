import { paragraph, renderEmail } from "./compose";
import { escapeHtml } from "./shared";

/** Security notice to the OLD address when an email change is requested. */
export function emailChangeNoticeTemplate(newEmail: string): { subject: string; html: string; text: string } {
  const subject = "Your Seazn Club email address is being changed";
  return {
    subject,
    html: renderEmail({
      subject,
      preheader: "A change to your account email was requested — review if this wasn't you.",
      eyebrow: "Security",
      title: "Email change requested",
      contentHtml: paragraph(
        `Someone requested a change to the email address on your account to <strong>${escapeHtml(newEmail)}</strong>. ` +
          "The change will take effect once the new address is confirmed. If this wasn't you, contact support immediately.",
      ),
      footerNote: "This notice was sent to the address currently on your account.",
    }),
    text: `Your account email is being changed to ${newEmail}. If this wasn't you, contact support.`,
  };
}
