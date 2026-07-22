import { button, linkFallback, paragraph, renderEmail } from "./compose";
import { escapeHtml } from "./shared";
import { t, type Dict } from "@/lib/i18n";

/** Billing-group transfer COMPLETE notice. Fired on the immediate (community /
 *  no-live-subscription) handover, where the recipient accepted nothing — the
 *  group is simply now on their account and they pay for it. Distinct from
 *  transfer-offer.ts, which asks the recipient to add a card and take it over.
 *  `dict` = emails namespace for the recipient's locale (see lib/email.ts). */
export function transferCompleteTemplate(
  payerName: string,
  groupName: string,
  link: string,
  dict: Dict,
): { subject: string; html: string; text: string } {
  const subject = t(dict, "transferComplete.subject");
  return {
    subject,
    html: renderEmail({
      subject,
      preheader: t(dict, "transferComplete.preheader", { payerName, groupName }),
      mastheadTag: groupName,
      eyebrow: t(dict, "transferComplete.eyebrow"),
      title: t(dict, "transferComplete.title"),
      contentHtml:
        paragraph(
          t(dict, "transferComplete.body", {
            payerName: escapeHtml(payerName),
            groupName: escapeHtml(groupName),
          }),
        ) +
        button(t(dict, "transferComplete.button"), link) +
        linkFallback(link),
      footerNote: t(dict, "transferComplete.footer", { payerName }),
    }),
    text: t(dict, "transferComplete.text", { payerName, groupName, link }),
  };
}
