import { panel, paragraph, renderEmail } from "./compose";
import { escapeHtml, money } from "./shared";
import { t, type Dict } from "@/lib/i18n";

export interface SponsorDisputeAlertArgs {
  orgName: string;
  packageName: string;
  sponsorName: string;
  amountCents: number;
  currency: string;
}

/** Organiser-facing alert: a sponsorship package payment was disputed
 *  (chargeback). Sponsor charges are destination charges, so the platform
 *  fronts the dispute — the organiser needs to know the placement is contested
 *  and the money is at risk. `dict` = emails namespace for the recipient's
 *  locale. */
export function sponsorDisputeAlertTemplate(
  opts: SponsorDisputeAlertArgs,
  dict: Dict,
): { subject: string; html: string; text: string } {
  const amount = money(opts.amountCents, opts.currency);
  const subject = t(dict, "sponsorDisputeAlert.subject", { orgName: opts.orgName });
  return {
    subject,
    html: renderEmail({
      subject,
      preheader: t(dict, "sponsorDisputeAlert.preheader", { amount }),
      mastheadTag: opts.orgName,
      eyebrow: `${opts.orgName} · ${opts.packageName}`,
      title: t(dict, "sponsorDisputeAlert.title"),
      contentHtml:
        paragraph(
          t(dict, "sponsorDisputeAlert.body", {
            sponsorName: escapeHtml(opts.sponsorName),
            amount,
            packageName: escapeHtml(opts.packageName),
            orgName: escapeHtml(opts.orgName),
          }),
        ) +
        panel(
          t(dict, "sponsorDisputeAlert.panelTitle"),
          t(dict, "sponsorDisputeAlert.panelBody"),
        ),
      footerNote: t(dict, "sponsorDisputeAlert.footer", { orgName: opts.orgName }),
    }),
    text:
      t(dict, "sponsorDisputeAlert.textLine", {
        packageName: opts.packageName,
        orgName: opts.orgName,
      }) +
      "\n" +
      t(dict, "sponsorDisputeAlert.textAmount", { amount, sponsorName: opts.sponsorName }) +
      "\n" +
      t(dict, "sponsorDisputeAlert.textNext"),
  };
}
