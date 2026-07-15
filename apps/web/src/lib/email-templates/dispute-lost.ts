import { button, panel, paragraph, renderEmail } from "./compose";
import { escapeHtml, money } from "./shared";
import { t, type Dict } from "@/lib/i18n";

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
 *  platform covered Stripe's dispute fee (PROMPT-55). `dict` = emails namespace
 *  for the recipient's locale. */
export function disputeLostTemplate(
  opts: DisputeLostArgs,
  dict: Dict,
): { subject: string; html: string; text: string } {
  const amount = money(opts.amountCents, opts.currency);
  const recovered = money(opts.recoveredCents, opts.currency);
  const recoveredOk = opts.recoveredCents > 0;
  const refHtml = opts.refCode
    ? t(dict, "disputeLost.refClause", { refCode: escapeHtml(opts.refCode) })
    : "";
  const refText = opts.refCode ? t(dict, "disputeLost.refClause", { refCode: opts.refCode }) : "";
  const subject = t(dict, "disputeLost.subject", { competitionName: opts.competitionName });
  return {
    subject,
    html: renderEmail({
      subject,
      preheader: t(dict, "disputeLost.preheader", { amount }),
      mastheadTag: opts.orgName,
      eyebrow: `${opts.orgName} · ${opts.competitionName}`,
      title: t(dict, "disputeLost.title"),
      contentHtml:
        paragraph(
          t(dict, "disputeLost.body", {
            amount,
            displayName: escapeHtml(opts.displayName),
            ref: refHtml,
            competitionName: escapeHtml(opts.competitionName),
          }),
        ) +
        panel(
          t(dict, "disputeLost.panelTitle"),
          recoveredOk
            ? t(dict, "disputeLost.recovered", { recovered })
            : t(dict, "disputeLost.notRecovered"),
        ) +
        button(t(dict, "disputeLost.button"), opts.consoleUrl),
      footerNote: t(dict, "disputeLost.footer"),
    }),
    text:
      t(dict, "disputeLost.textLine", {
        competitionName: opts.competitionName,
        orgName: opts.orgName,
      }) +
      "\n" +
      t(dict, "disputeLost.textDisputed", {
        amount,
        displayName: opts.displayName,
        ref: refText,
      }) +
      "\n" +
      t(dict, "disputeLost.textRepaid") +
      "\n" +
      (recoveredOk
        ? t(dict, "disputeLost.textRecovered", { recovered })
        : t(dict, "disputeLost.textNotRecovered")) +
      "\n" +
      t(dict, "disputeLost.textConsole", { consoleUrl: opts.consoleUrl }),
  };
}
