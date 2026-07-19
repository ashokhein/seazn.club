import { panel, paragraph, renderEmail } from "./compose";
import { escapeHtml, money } from "./shared";
import { t, type Dict } from "@/lib/i18n";

export interface SponsorDisputeWonArgs {
  orgName: string;
  packageName: string;
  sponsorName: string;
  amountCents: number;
  currency: string;
}

/** Organiser-facing outcome mail: a sponsorship chargeback closed WON. The
 *  alert (created) and lost mails both exist; without this one a win was
 *  silent — the flag cleared and the placement returned with no explanation.
 *  States that the money stays and the placement is live again. `dict` =
 *  emails namespace for the recipient's locale. */
export function sponsorDisputeWonTemplate(
  opts: SponsorDisputeWonArgs,
  dict: Dict,
): { subject: string; html: string; text: string } {
  const amount = money(opts.amountCents, opts.currency);
  const subject = t(dict, "sponsorDisputeWon.subject", { orgName: opts.orgName });
  return {
    subject,
    html: renderEmail({
      subject,
      preheader: t(dict, "sponsorDisputeWon.preheader", { amount }),
      mastheadTag: opts.orgName,
      eyebrow: `${opts.orgName} · ${opts.packageName}`,
      title: t(dict, "sponsorDisputeWon.title"),
      contentHtml:
        paragraph(
          t(dict, "sponsorDisputeWon.body", {
            sponsorName: escapeHtml(opts.sponsorName),
            amount,
            packageName: escapeHtml(opts.packageName),
            orgName: escapeHtml(opts.orgName),
          }),
        ) + panel(t(dict, "sponsorDisputeWon.panelTitle"), t(dict, "sponsorDisputeWon.panelBody")),
      footerNote: t(dict, "sponsorDisputeWon.footer", { orgName: opts.orgName }),
    }),
    text:
      t(dict, "sponsorDisputeWon.textLine", {
        packageName: opts.packageName,
        orgName: opts.orgName,
      }) +
      "\n" +
      t(dict, "sponsorDisputeWon.textKept", { amount, sponsorName: opts.sponsorName }),
  };
}
