import { button, panel, paragraph, renderEmail } from "./compose";
import { escapeHtml, money } from "./shared";
import { formatDeadline } from "./registration";
import { t, type Dict } from "@/lib/i18n";
import {
  fillPaymentInstructions,
  paymentInstructionsText,
} from "@/lib/payment-instructions";

export interface PaymentReminderArgs {
  orgName: string;
  competitionName: string;
  displayName: string;
  feeCents: number;
  currency: string;
  paymentInstructions: string | null;
  /** Card entries (sweep T-24h reminder): fresh checkout link + deadline. */
  checkoutUrl?: string | null;
  payDeadline?: Date | string | null;
  /** Fills {{reference}} in the instructions. */
  refCode?: string | null;
}

/** Payment nudge for an unpaid entry fee — organiser-triggered (offline) or
 *  sweep-triggered at T-24h with a fresh checkout link (card). `dict` = emails
 *  namespace for the recipient's locale. */
export function paymentReminderTemplate(
  opts: PaymentReminderArgs,
  dict: Dict,
): { subject: string; html: string; text: string } {
  const amount = money(opts.feeCents, opts.currency);
  const deadline = opts.payDeadline ? formatDeadline(opts.payDeadline) : null;
  const instructions = opts.paymentInstructions
    ? paymentInstructionsText(fillPaymentInstructions(opts.paymentInstructions, opts.refCode))
    : null;
  const how = opts.checkoutUrl
    ? panel(
        t(dict, "paymentReminder.completePanelTitle"),
        deadline
          ? t(dict, "paymentReminder.completeHeldUntil", { deadline })
          : t(dict, "paymentReminder.completeHeld"),
      ) + button(t(dict, "paymentReminder.payNow", { amount }), opts.checkoutUrl)
    : instructions
      ? panel(t(dict, "paymentReminder.howToPayTitle"), instructions)
      : paragraph(t(dict, "paymentReminder.contactOrg", { orgName: escapeHtml(opts.orgName) }));

  const subject = t(dict, "paymentReminder.subject", { competitionName: opts.competitionName });
  return {
    subject,
    html: renderEmail({
      subject,
      preheader: t(dict, "paymentReminder.preheader", {
        amount,
        competitionName: opts.competitionName,
      }),
      mastheadTag: opts.orgName,
      eyebrow: `${opts.orgName} · ${opts.competitionName}`,
      title: t(dict, "paymentReminder.title"),
      contentHtml:
        paragraph(
          t(dict, "paymentReminder.body", {
            displayName: escapeHtml(opts.displayName),
            competitionName: escapeHtml(opts.competitionName),
            amount,
          }),
        ) + how,
      footerNote: t(dict, "paymentReminder.footer"),
    }),
    text:
      t(dict, "paymentReminder.textLine", {
        competitionName: opts.competitionName,
        orgName: opts.orgName,
      }) +
      "\n" +
      t(dict, "paymentReminder.textFee", { amount }) +
      (opts.checkoutUrl
        ? "\n" +
          (deadline
            ? t(dict, "paymentReminder.textHeldUntil", { deadline })
            : t(dict, "paymentReminder.textHeld")) +
          "\n" +
          opts.checkoutUrl
        : instructions
          ? "\n" + t(dict, "paymentReminder.textHowToPay") + "\n" + instructions
          : "\n" + t(dict, "paymentReminder.textContactOrg")) +
      "\n\n" +
      t(dict, "paymentReminder.textAlreadyPaid"),
  };
}
