import { button, linkFallback, paragraph, renderEmail } from "./compose";
import { t, type Dict } from "@/lib/i18n";

/** Confirm-new-email link (expires in 24 hours). `dict` = emails namespace for
 *  the recipient's locale (see lib/email.ts senders). */
export function emailChangeConfirmTemplate(
  link: string,
  dict: Dict,
): { subject: string; html: string; text: string } {
  const subject = t(dict, "emailChangeConfirm.subject");
  return {
    subject,
    html: renderEmail({
      subject,
      preheader: t(dict, "emailChangeConfirm.preheader"),
      eyebrow: t(dict, "account.eyebrow"),
      title: t(dict, "emailChangeConfirm.title"),
      contentHtml:
        paragraph(t(dict, "emailChangeConfirm.body")) +
        button(t(dict, "emailChangeConfirm.button"), link) +
        linkFallback(link),
      footerNote: t(dict, "ignoreNote"),
    }),
    text: t(dict, "emailChangeConfirm.text", { link }),
  };
}
