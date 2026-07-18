import { panel, paragraph, renderEmail } from "./compose";
import { escapeHtml, money } from "./shared";
import { t, type Dict } from "@/lib/i18n";

export interface SponsorDisputeLostArgs {
  orgName: string;
  packageName: string;
  sponsorName: string;
  amountCents: number;
  currency: string;
  /** What the transfer reversal pulled back from the club's Stripe balance;
   *  0 when the automatic recovery failed or was skipped. */
  recoveredCents: number;
}

/** Organiser-facing outcome mail: a sponsorship chargeback closed lost. States
 *  the write-off and whether the amount was recovered from the club's Stripe
 *  balance while the platform covered Stripe's dispute fee (mirrors the
 *  entry-fee dispute-lost mail). `dict` = emails namespace for the recipient's
 *  locale. */
export function sponsorDisputeLostTemplate(
  opts: SponsorDisputeLostArgs,
  dict: Dict,
): { subject: string; html: string; text: string } {
  const amount = money(opts.amountCents, opts.currency);
  const recovered = money(opts.recoveredCents, opts.currency);
  const recoveredOk = opts.recoveredCents > 0;
  const subject = t(dict, "sponsorDisputeLost.subject", { orgName: opts.orgName });
  return {
    subject,
    html: renderEmail({
      subject,
      preheader: t(dict, "sponsorDisputeLost.preheader", { amount }),
      mastheadTag: opts.orgName,
      eyebrow: `${opts.orgName} · ${opts.packageName}`,
      title: t(dict, "sponsorDisputeLost.title"),
      contentHtml:
        paragraph(
          t(dict, "sponsorDisputeLost.body", {
            sponsorName: escapeHtml(opts.sponsorName),
            amount,
            packageName: escapeHtml(opts.packageName),
            orgName: escapeHtml(opts.orgName),
          }),
        ) +
        panel(
          t(dict, "sponsorDisputeLost.panelTitle"),
          recoveredOk
            ? t(dict, "sponsorDisputeLost.recovered", { recovered })
            : t(dict, "sponsorDisputeLost.notRecovered"),
        ),
      footerNote: t(dict, "sponsorDisputeLost.footer", { orgName: opts.orgName }),
    }),
    text:
      t(dict, "sponsorDisputeLost.textLine", {
        packageName: opts.packageName,
        orgName: opts.orgName,
      }) +
      "\n" +
      t(dict, "sponsorDisputeLost.textRepaid", { amount, sponsorName: opts.sponsorName }) +
      "\n" +
      (recoveredOk
        ? t(dict, "sponsorDisputeLost.textRecovered", { recovered })
        : t(dict, "sponsorDisputeLost.textNotRecovered")),
  };
}
