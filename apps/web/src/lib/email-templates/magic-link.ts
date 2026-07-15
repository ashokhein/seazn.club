import { button, linkFallback, paragraph, renderEmail } from "./compose";
import { t, type Dict } from "@/lib/i18n";

/** Passwordless sign-in link (expires in 15 minutes). `dict` = emails namespace
 *  for the recipient's locale (see lib/email.ts senders). */
export function magicLinkTemplate(
  link: string,
  dict: Dict,
): { subject: string; html: string; text: string } {
  const subject = t(dict, "magicLink.subject");
  return {
    subject,
    html: renderEmail({
      subject,
      preheader: t(dict, "magicLink.preheader"),
      eyebrow: t(dict, "account.eyebrow"),
      title: t(dict, "magicLink.title"),
      contentHtml:
        paragraph(t(dict, "magicLink.body")) +
        button(t(dict, "magicLink.button"), link) +
        linkFallback(link),
      footerNote: t(dict, "ignoreNote"),
    }),
    text: t(dict, "magicLink.text", { link }),
  };
}
