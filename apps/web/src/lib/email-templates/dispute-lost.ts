import { button, panel, paragraph, renderEmail } from "./compose";
import { escapeHtml, money } from "./shared";

export interface DisputeLostArgs {
  orgName: string;
  competitionName: string;
  /** Registrant the disputed payment belonged to. */
  displayName: string;
  /** Disputed amount (the full write-off on the entry). */
  amountCents: number;
  currency: string;
  refCode?: string | null;
  /** What the transfer reversal actually pulled back from the club's Stripe
   *  balance; 0 when the automatic recovery failed or was skipped. */
  recoveredCents: number;
  /** Registrations console for the affected division. */
  consoleUrl: string;
}

/** Organiser-facing outcome mail: a chargeback was lost. States plainly that
 *  the disputed amount was recovered from the club's Stripe balance while the
 *  platform covered Stripe's dispute fee (PROMPT-55). */
export function disputeLostTemplate(
  opts: DisputeLostArgs,
): { subject: string; html: string; text: string } {
  const amount = money(opts.amountCents, opts.currency);
  const recovered = money(opts.recoveredCents, opts.currency);
  const ref = opts.refCode ? ` (ref ${opts.refCode})` : "";
  const moneyLine =
    opts.recoveredCents > 0
      ? `${recovered} has been recovered from your Stripe balance — if your balance can't cover it, ` +
        "Stripe deducts it from your upcoming payouts. Seazn Club covered Stripe's dispute fee."
      : "We could not automatically recover the amount from your Stripe balance — our team will follow up. " +
        "Seazn Club covered Stripe's dispute fee.";
  return {
    subject: `Dispute lost — ${opts.competitionName}`,
    html: renderEmail({
      subject: `Dispute lost — ${opts.competitionName}`,
      preheader: `${amount} entry-fee dispute closed against you.`,
      mastheadTag: opts.orgName,
      eyebrow: `${opts.orgName} · ${opts.competitionName}`,
      title: "Dispute lost",
      contentHtml:
        paragraph(
          `The ${amount} entry-fee dispute from <strong>${escapeHtml(opts.displayName)}</strong>` +
            (opts.refCode ? ` (ref ${escapeHtml(opts.refCode)})` : "") +
            ` for ${escapeHtml(opts.competitionName)} was closed in the cardholder's favour. ` +
            "The cardholder has been repaid by Stripe and the entry is marked refunded on your console.",
        ) +
        panel("What this means for you", escapeHtml(moneyLine)) +
        button("Open registrations", opts.consoleUrl),
      footerNote: "You received this because you own the organisation on seazn.club.",
    }),
    text:
      `Dispute lost — ${opts.competitionName} (${opts.orgName}).\n` +
      `Disputed: ${amount} from ${opts.displayName}${ref}.\n` +
      `The cardholder has been repaid by Stripe and the entry is marked refunded.\n` +
      (opts.recoveredCents > 0
        ? `${recovered} has been recovered from your Stripe balance; Seazn Club covered Stripe's dispute fee.\n`
        : `We could not automatically recover the amount from your Stripe balance — our team will follow up. Seazn Club covered Stripe's dispute fee.\n`) +
      `Registrations: ${opts.consoleUrl}`,
  };
}
