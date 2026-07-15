import { panel, paragraph, renderEmail } from "./compose";
import { escapeHtml, money } from "./shared";
import { t, type Dict } from "@/lib/i18n";

export interface RefundIssuedArgs {
  orgName: string;
  competitionName: string;
  displayName: string;
  amountCents: number;
  currency: string;
  refCode?: string | null;
}

/** Refund confirmation to the registrant (auto, manual, late or duplicate —
 *  the reason stays organiser-side; the registrant just needs the receipt).
 *  `dict` = emails namespace for the recipient's locale. */
export function refundIssuedTemplate(
  opts: RefundIssuedArgs,
  dict: Dict,
): { subject: string; html: string; text: string } {
  const amount = money(opts.amountCents, opts.currency);
  const subject = t(dict, "refundIssued.subject", { competitionName: opts.competitionName });
  return {
    subject,
    html: renderEmail({
      subject,
      preheader: t(dict, "refundIssued.preheader", { amount }),
      mastheadTag: opts.orgName,
      eyebrow: `${opts.orgName} · ${opts.competitionName}`,
      title: t(dict, "refundIssued.title"),
      contentHtml:
        paragraph(
          t(dict, "refundIssued.body", {
            displayName: escapeHtml(opts.displayName),
            amount,
            competitionName: escapeHtml(opts.competitionName),
          }),
        ) +
        panel(t(dict, "refundIssued.panelTitle"), t(dict, "refundIssued.panelBody")) +
        (opts.refCode
          ? paragraph(t(dict, "refundIssued.reference", { refCode: escapeHtml(opts.refCode) }))
          : ""),
      footerNote: t(dict, "refundIssued.footer", {
        competitionName: opts.competitionName,
        orgName: opts.orgName,
      }),
    }),
    text:
      t(dict, "refundIssued.text", {
        competitionName: opts.competitionName,
        orgName: opts.orgName,
      }) +
      "\n" +
      t(dict, "refundIssued.textAmount", { amount }) +
      (opts.refCode ? "\n" + t(dict, "refundIssued.textReference", { refCode: opts.refCode }) : ""),
  };
}
