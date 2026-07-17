import { panel, paragraph, renderEmail } from "./compose";
import { escapeHtml, money } from "./shared";
import { t, type Dict } from "@/lib/i18n";

export interface SponsorRefundArgs {
  orgName: string;
  packageName: string;
  sponsorName: string;
  amountCents: number;
  currency: string;
}

/** Refund notice to the sponsor when a paid order is refunded (console
 *  action or Stripe-dashboard refund). `dict` = emails namespace; en default. */
export function sponsorRefundTemplate(
  opts: SponsorRefundArgs,
  dict: Dict,
): { subject: string; html: string; text: string } {
  const amount = money(opts.amountCents, opts.currency);
  const subject = t(dict, "sponsorRefund.subject", { orgName: opts.orgName });
  return {
    subject,
    html: renderEmail({
      subject,
      preheader: t(dict, "sponsorRefund.preheader", { amount }),
      mastheadTag: opts.orgName,
      eyebrow: `${opts.orgName} · ${opts.packageName}`,
      title: t(dict, "sponsorRefund.title"),
      contentHtml:
        paragraph(
          t(dict, "sponsorRefund.body", {
            sponsorName: escapeHtml(opts.sponsorName),
            amount,
            packageName: escapeHtml(opts.packageName),
            orgName: escapeHtml(opts.orgName),
          }),
        ) + panel(t(dict, "sponsorRefund.panelTitle"), t(dict, "sponsorRefund.panelBody")),
      footerNote: t(dict, "sponsorRefund.footer", { orgName: opts.orgName }),
    }),
    text:
      t(dict, "sponsorRefund.textLine", {
        packageName: opts.packageName,
        orgName: opts.orgName,
      }) +
      "\n" +
      t(dict, "sponsorRefund.textAmount", { amount }),
  };
}
