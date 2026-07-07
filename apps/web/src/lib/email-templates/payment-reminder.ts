import { card, escapeHtml, money } from "./shared";

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
    ? `<div style="margin:16px 0;padding:16px;border:1px solid #e9d5ff;border-radius:12px;background:#faf5ff">
         <p style="margin:0 0 8px;color:#6b21a8;font-weight:600">How to pay</p>
         <p style="margin:0;color:#334155;white-space:pre-line">${escapeHtml(opts.paymentInstructions)}</p>
       </div>`
    : `<p style="color:#334155">Please contact ${escapeHtml(opts.orgName)} to arrange payment.</p>`;

  return {
    subject: `Payment reminder — ${opts.competitionName}`,
    html: card(
      "Entry fee still due",
      `Hi ${escapeHtml(opts.displayName)}, your entry for <strong>${escapeHtml(opts.competitionName)}</strong> is confirmed once the ${amount} entry fee is received.`,
      how,
      "If you've already paid, please ignore this — it can take the organiser a little time to reconcile.",
    ),
    text:
      `Payment reminder for ${opts.competitionName} (${opts.orgName}).\n` +
      `Entry fee: ${amount}.` +
      (opts.paymentInstructions ? `\nHow to pay:\n${opts.paymentInstructions}` : `\nPlease contact the organiser to arrange payment.`) +
      `\n\nIf you've already paid, please ignore this.`,
  };
}
