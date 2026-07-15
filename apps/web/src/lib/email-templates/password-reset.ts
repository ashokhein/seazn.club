import { button, linkFallback, paragraph, renderEmail } from "./compose";
import { t, type Dict } from "@/lib/i18n";

/** Password-reset link (expires in 1 hour). `dict` = emails namespace for the
 *  recipient's locale (see lib/email.ts senders). */
export function passwordResetTemplate(
  link: string,
  dict: Dict,
): { subject: string; html: string; text: string } {
  const subject = t(dict, "passwordReset.subject");
  return {
    subject,
    html: renderEmail({
      subject,
      preheader: t(dict, "passwordReset.preheader"),
      eyebrow: t(dict, "account.eyebrow"),
      title: t(dict, "passwordReset.title"),
      contentHtml:
        paragraph(t(dict, "passwordReset.body")) +
        button(t(dict, "passwordReset.button"), link) +
        linkFallback(link),
      footerNote: t(dict, "ignoreNote"),
    }),
    text: t(dict, "passwordReset.text", { link }),
  };
}
