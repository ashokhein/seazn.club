import { panel, paragraph, renderEmail } from "./compose";
import { escapeHtml, money } from "./shared";
import { t, type Dict } from "@/lib/i18n";

export interface SponsorReceiptArgs {
  orgName: string;
  packageName: string;
  sponsorName: string;
  amountCents: number;
  currency: string;
  publicUrl?: string | null;
}

/** Payment receipt to the sponsor once the order is paid and the placement
 *  is live (v10 PROMPT-56). `dict` = emails namespace; defaults to en. */
export function sponsorReceiptTemplate(
  opts: SponsorReceiptArgs,
  dict: Dict,
): { subject: string; html: string; text: string } {
  const amount = money(opts.amountCents, opts.currency);
  const subject = t(dict, "sponsorReceipt.subject", { orgName: opts.orgName });
  return {
    subject,
    html: renderEmail({
      subject,
      preheader: t(dict, "sponsorReceipt.preheader", { orgName: opts.orgName }),
      mastheadTag: opts.orgName,
      eyebrow: `${opts.orgName} · ${opts.packageName}`,
      title: t(dict, "sponsorReceipt.title"),
      contentHtml:
        paragraph(
          t(dict, "sponsorReceipt.body", {
            sponsorName: escapeHtml(opts.sponsorName),
            orgName: escapeHtml(opts.orgName),
            packageName: escapeHtml(opts.packageName),
            amount,
          }),
        ) +
        panel(t(dict, "sponsorReceipt.panelTitle"), t(dict, "sponsorReceipt.panelBody")) +
        (opts.publicUrl
          ? paragraph(t(dict, "sponsorReceipt.seeIt", { url: opts.publicUrl }))
          : ""),
      footerNote: t(dict, "sponsorReceipt.footer", { orgName: opts.orgName }),
    }),
    text:
      t(dict, "sponsorReceipt.textLine", {
        packageName: opts.packageName,
        orgName: opts.orgName,
      }) +
      "\n" +
      t(dict, "sponsorReceipt.textAmount", { amount }) +
      (opts.publicUrl ? "\n" + opts.publicUrl : ""),
  };
}
