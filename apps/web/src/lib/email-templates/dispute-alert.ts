import { panel, paragraph, renderEmail } from "./compose";
import { escapeHtml, money } from "./shared";

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
 *  to know the entry is contested and evidence may be needed. */
export function disputeAlertTemplate(
  opts: DisputeAlertArgs,
): { subject: string; html: string; text: string } {
  const amount = money(opts.amountCents, opts.currency);
  return {
    subject: `Payment dispute opened — ${opts.competitionName}`,
    html: renderEmail({
      subject: `Payment dispute opened — ${opts.competitionName}`,
      preheader: `${amount} entry-fee payment disputed — action may be needed.`,
      mastheadTag: opts.orgName,
      eyebrow: `${opts.orgName} · ${opts.competitionName}`,
      title: "Payment dispute opened",
      contentHtml:
        paragraph(
          `The ${amount} entry-fee payment from <strong>${escapeHtml(opts.displayName)}</strong>` +
            (opts.refCode ? ` (ref ${escapeHtml(opts.refCode)})` : "") +
            ` for ${escapeHtml(opts.competitionName)} has been disputed by the cardholder.`,
        ) +
        panel(
          "What happens next",
          "The registration is flagged on your console. If the dispute is lost, the cardholder is repaid and the amount is recovered from your Stripe balance. " +
            "Check the entry, and gather anything that proves the registration was genuine (the confirmation email, check-in records).",
        ),
      footerNote: "You received this because you own the organisation on seazn.club.",
    }),
    text:
      `Payment dispute opened — ${opts.competitionName} (${opts.orgName}).\n` +
      `Disputed: ${amount} from ${opts.displayName}` +
      (opts.refCode ? ` (ref ${opts.refCode})` : "") +
      `.\nThe registration is flagged on your console. If the dispute is lost, the cardholder is repaid and the amount is recovered from your Stripe balance.`,
  };
}
