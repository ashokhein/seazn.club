import { button, linkFallback, paragraph, renderEmail } from "./compose";
import { t, type Dict } from "@/lib/i18n";

/** Email-verification link sent at sign-up. `dict` = emails namespace for the
 *  recipient's locale (see lib/email.ts senders). */
export function verificationTemplate(
  link: string,
  dict: Dict,
): { subject: string; html: string; text: string } {
  const subject = t(dict, "verification.subject");
  return {
    subject,
    html: renderEmail({
      subject,
      preheader: t(dict, "verification.preheader"),
      eyebrow: t(dict, "account.eyebrow"),
      title: t(dict, "verification.title"),
      contentHtml:
        paragraph(t(dict, "verification.body")) +
        button(t(dict, "verification.button"), link) +
        linkFallback(link),
      footerNote: t(dict, "verification.footer"),
    }),
    text: t(dict, "verification.text", { link }),
  };
}
