import { panel, paragraph, renderEmail } from "./compose";
import { escapeHtml, money } from "./shared";

export interface PaymentReminderArgs {
  orgName: string;
  competitionName: string;
  displayName: string;
  feeCents: number;
  currency: string;
  paymentInstructions: string | null;
}

/** Organiser-triggered nudge for an unpaid (offline) entry fee. */
export function paymentReminderTemplate(
  opts: PaymentReminderArgs,
): { subject: string; html: string; text: string } {
  const amount = money(opts.feeCents, opts.currency);
  const how = opts.paymentInstructions
    ? panel("How to pay", opts.paymentInstructions)
    : paragraph(`Please contact ${escapeHtml(opts.orgName)} to arrange payment.`);

  return {
    subject: `Payment reminder — ${opts.competitionName}`,
    html: renderEmail({
      subject: `Payment reminder — ${opts.competitionName}`,
      preheader: `Your ${amount} entry fee for ${opts.competitionName} is still due.`,
      mastheadTag: opts.orgName,
      eyebrow: `${opts.orgName} · ${opts.competitionName}`,
      title: "Entry fee still due",
      contentHtml:
        paragraph(
          `Hi ${escapeHtml(opts.displayName)}, your entry for <strong>${escapeHtml(opts.competitionName)}</strong> is confirmed once the ${amount} entry fee is received.`,
        ) + how,
      footerNote:
        "If you've already paid, please ignore this — it can take the organiser a little time to reconcile.",
    }),
    text:
      `Payment reminder for ${opts.competitionName} (${opts.orgName}).\n` +
      `Entry fee: ${amount}.` +
      (opts.paymentInstructions ? `\nHow to pay:\n${opts.paymentInstructions}` : `\nPlease contact the organiser to arrange payment.`) +
      `\n\nIf you've already paid, please ignore this.`,
  };
}
