import { paragraph, renderEmail } from "./compose";
import { escapeHtml } from "./shared";
import { t, type Dict } from "@/lib/i18n";

/** Security notice to the OLD address when an email change is requested.
 *  `dict` = emails namespace for the recipient's locale. */
export function emailChangeNoticeTemplate(
  newEmail: string,
  dict: Dict,
): { subject: string; html: string; text: string } {
  const subject = t(dict, "emailChangeNotice.subject");
  return {
    subject,
    html: renderEmail({
      subject,
      preheader: t(dict, "emailChangeNotice.preheader"),
      eyebrow: t(dict, "emailChangeNotice.eyebrow"),
      title: t(dict, "emailChangeNotice.title"),
      contentHtml: paragraph(
        t(dict, "emailChangeNotice.body", { newEmail: escapeHtml(newEmail) }),
      ),
      footerNote: t(dict, "emailChangeNotice.footer"),
    }),
    text: t(dict, "emailChangeNotice.text", { newEmail }),
  };
}
