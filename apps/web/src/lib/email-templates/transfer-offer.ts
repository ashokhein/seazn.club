import { button, linkFallback, paragraph, renderEmail } from "./compose";
import { escapeHtml } from "./shared";
import { t, type Dict } from "@/lib/i18n";

/** Billing-group transfer offer link. Fired when a payer offers a whole billing
 *  group to another user; the recipient adds their own card to take it over.
 *  `dict` = emails namespace for the recipient's locale (see lib/email.ts). */
export function transferOfferTemplate(
  payerName: string,
  groupName: string,
  link: string,
  dict: Dict,
): { subject: string; html: string; text: string } {
  const subject = t(dict, "transferOffer.subject");
  return {
    subject,
    html: renderEmail({
      subject,
      preheader: t(dict, "transferOffer.preheader", { payerName, groupName }),
      mastheadTag: groupName,
      eyebrow: t(dict, "transferOffer.eyebrow"),
      title: t(dict, "transferOffer.title"),
      contentHtml:
        paragraph(
          t(dict, "transferOffer.body", {
            payerName: escapeHtml(payerName),
            groupName: escapeHtml(groupName),
          }),
        ) +
        button(t(dict, "transferOffer.button"), link) +
        linkFallback(link),
      footerNote: t(dict, "transferOffer.footer", { payerName }),
    }),
    text: t(dict, "transferOffer.text", { payerName, groupName, link }),
  };
}
