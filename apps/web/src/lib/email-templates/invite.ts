import { button, linkFallback, paragraph, renderEmail } from "./compose";
import { escapeHtml } from "./shared";
import { t, type Dict } from "@/lib/i18n";

/** Org invite acceptance link. `dict` = emails namespace for the recipient's
 *  locale (see lib/email.ts senders). */
export function inviteTemplate(
  orgName: string,
  link: string,
  dict: Dict,
): { subject: string; html: string; text: string } {
  const subject = t(dict, "invite.subject", { orgName });
  return {
    subject,
    html: renderEmail({
      subject,
      preheader: t(dict, "invite.preheader", { orgName }),
      mastheadTag: orgName,
      // The org already headlines the masthead — the eyebrow says what KIND
      // of mail this is instead of repeating it.
      eyebrow: t(dict, "invite.eyebrow"),
      title: t(dict, "invite.title"),
      contentHtml:
        paragraph(t(dict, "invite.body", { orgName: escapeHtml(orgName) })) +
        button(t(dict, "invite.button"), link) +
        linkFallback(link),
      footerNote: t(dict, "invite.footer", { orgName }),
    }),
    text: t(dict, "invite.text", { orgName, link }),
  };
}
