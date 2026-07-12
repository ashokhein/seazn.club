import { panel, paragraph, renderEmail } from "./compose";
import { escapeHtml, money } from "./shared";

export interface RefundIssuedArgs {
  orgName: string;
  competitionName: string;
  displayName: string;
  amountCents: number;
  currency: string;
  refCode?: string | null;
}

/** Refund confirmation to the registrant (auto, manual, late or duplicate —
 *  the reason stays organiser-side; the registrant just needs the receipt). */
export function refundIssuedTemplate(
  opts: RefundIssuedArgs,
): { subject: string; html: string; text: string } {
  const amount = money(opts.amountCents, opts.currency);
  return {
    subject: `Refund issued — ${opts.competitionName}`,
    html: renderEmail({
      subject: `Refund issued — ${opts.competitionName}`,
      preheader: `${amount} is on its way back to your card.`,
      mastheadTag: opts.orgName,
      eyebrow: `${opts.orgName} · ${opts.competitionName}`,
      title: "Refund issued",
      contentHtml:
        paragraph(
          `Hi ${escapeHtml(opts.displayName)} — a refund of <strong>${amount}</strong> for your ${escapeHtml(opts.competitionName)} entry has been issued.`,
        ) +
        panel(
          "When it lands",
          "Refunds usually reach the original card within 5–10 business days, depending on your bank.",
        ) +
        (opts.refCode
          ? paragraph(`Registration reference: <strong>${escapeHtml(opts.refCode)}</strong>.`)
          : ""),
      footerNote: `You received this because this address was used to enter ${opts.competitionName} at ${opts.orgName}.`,
    }),
    text:
      `Refund issued — ${opts.competitionName} (${opts.orgName}).\n` +
      `Amount: ${amount}. Refunds usually reach the original card within 5–10 business days.` +
      (opts.refCode ? `\nRegistration reference: ${opts.refCode}` : ""),
  };
}
