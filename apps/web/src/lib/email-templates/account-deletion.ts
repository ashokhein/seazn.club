import { paragraph, renderEmail } from "./compose";
import { t, type Dict } from "@/lib/i18n";

/** Confirmation that an account was scheduled for deletion. `dict` = emails
 *  namespace for the recipient's locale. */
export function accountDeletionTemplate(
  dict: Dict,
): { subject: string; html: string; text: string } {
  const subject = t(dict, "accountDeletion.subject");
  return {
    subject,
    html: renderEmail({
      subject,
      preheader: t(dict, "accountDeletion.preheader"),
      eyebrow: t(dict, "account.eyebrow"),
      title: t(dict, "accountDeletion.title"),
      contentHtml: paragraph(t(dict, "accountDeletion.body")),
      footerNote: t(dict, "accountDeletion.footer"),
    }),
    text: t(dict, "accountDeletion.text"),
  };
}
