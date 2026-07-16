import { button, panel, paragraph, renderEmail } from "./compose";
import { escapeHtml, money } from "./shared";
import { t, type Dict } from "@/lib/i18n";

export interface SponsorInvoiceArgs {
  orgName: string;
  packageName: string;
  sponsorName: string;
  amountCents: number;
  currency: string;
  checkoutUrl: string;
}

/** Pay-now invoice to the sponsor contact at checkout start (v10 PROMPT-56)
 *  — mirrors payment-reminder's card path. Sponsors have no stored locale;
 *  callers pass the en dict unless one is known. */
export function sponsorInvoiceTemplate(
  opts: SponsorInvoiceArgs,
  dict: Dict,
): { subject: string; html: string; text: string } {
  const amount = money(opts.amountCents, opts.currency);
  const subject = t(dict, "sponsorInvoice.subject", { orgName: opts.orgName });
  return {
    subject,
    html: renderEmail({
      subject,
      preheader: t(dict, "sponsorInvoice.preheader", { amount, orgName: opts.orgName }),
      mastheadTag: opts.orgName,
      eyebrow: `${opts.orgName} · ${opts.packageName}`,
      title: t(dict, "sponsorInvoice.title"),
      contentHtml:
        paragraph(
          t(dict, "sponsorInvoice.body", {
            sponsorName: escapeHtml(opts.sponsorName),
            orgName: escapeHtml(opts.orgName),
            packageName: escapeHtml(opts.packageName),
            amount,
          }),
        ) +
        panel(t(dict, "sponsorInvoice.panelTitle"), t(dict, "sponsorInvoice.panelBody")) +
        button(t(dict, "sponsorInvoice.payNow", { amount }), opts.checkoutUrl),
      footerNote: t(dict, "sponsorInvoice.footer", { orgName: opts.orgName }),
    }),
    text:
      t(dict, "sponsorInvoice.textLine", {
        packageName: opts.packageName,
        orgName: opts.orgName,
      }) +
      "\n" +
      t(dict, "sponsorInvoice.textAmount", { amount }) +
      "\n" +
      opts.checkoutUrl,
  };
}
