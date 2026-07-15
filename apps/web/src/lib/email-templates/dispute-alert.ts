import { panel, paragraph, renderEmail } from "./compose";
import { escapeHtml, money } from "./shared";
import { t, type Dict } from "@/lib/i18n";

export interface DisputeAlertArgs {
  orgName: string;
  competitionName: string;
  /** Registrant the disputed payment belongs to. */
  displayName: string;
  amountCents: number;
  currency: string;
  refCode?: string | null;
}

/** Organiser-facing alert: a card payment was disputed (chargeback). The
 *  platform fronts the dispute on destination charges — the organiser needs
 *  to know the entry is contested and evidence may be needed. `dict` = emails
 *  namespace for the recipient's locale. */
export function disputeAlertTemplate(
  opts: DisputeAlertArgs,
  dict: Dict,
): { subject: string; html: string; text: string } {
  const amount = money(opts.amountCents, opts.currency);
  const subject = t(dict, "disputeAlert.subject", { competitionName: opts.competitionName });
  const refHtml = opts.refCode
    ? t(dict, "disputeAlert.refClause", { refCode: escapeHtml(opts.refCode) })
    : "";
  const refText = opts.refCode ? t(dict, "disputeAlert.refClause", { refCode: opts.refCode }) : "";
  return {
    subject,
    html: renderEmail({
      subject,
      preheader: t(dict, "disputeAlert.preheader", { amount }),
      mastheadTag: opts.orgName,
      eyebrow: `${opts.orgName} · ${opts.competitionName}`,
      title: t(dict, "disputeAlert.title"),
      contentHtml:
        paragraph(
          t(dict, "disputeAlert.body", {
            amount,
            displayName: escapeHtml(opts.displayName),
            ref: refHtml,
            competitionName: escapeHtml(opts.competitionName),
          }),
        ) +
        panel(t(dict, "disputeAlert.panelTitle"), t(dict, "disputeAlert.panelBody")),
      footerNote: t(dict, "disputeAlert.footer"),
    }),
    text:
      t(dict, "disputeAlert.textLine", {
        competitionName: opts.competitionName,
        orgName: opts.orgName,
      }) +
      "\n" +
      t(dict, "disputeAlert.textDisputed", {
        amount,
        displayName: opts.displayName,
        ref: refText,
      }) +
      "\n" +
      t(dict, "disputeAlert.textNext"),
  };
}
