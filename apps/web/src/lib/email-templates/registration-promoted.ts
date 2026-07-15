import { button, linkFallback, panel, paragraph, renderEmail } from "./compose";
import { escapeHtml, money } from "./shared";
import { formatDeadline } from "./registration";
import { t, type Dict } from "@/lib/i18n";
import {
  fillPaymentInstructions,
  paymentInstructionsText,
} from "@/lib/payment-instructions";

export interface RegistrationPromotedArgs {
  orgName: string;
  competitionName: string;
  displayName: string;
  feeCents: number;
  currency: string;
  /** Card divisions: fresh checkout link + the new 48h deadline. */
  payUrl?: string | null;
  payDeadline?: Date | string | null;
  /** Offline divisions: resolved cash/bank instructions. */
  paymentInstructions?: string | null;
  refCode?: string | null;
  refStatusUrl?: string | null;
}

/** A waitlist spot opened (spec §2): the registrant is pending again — card
 *  entries pay inside the fresh window, offline entries follow instructions.
 *  `dict` = emails namespace for the recipient's locale. */
export function registrationPromotedTemplate(
  opts: RegistrationPromotedArgs,
  dict: Dict,
): { subject: string; html: string; text: string } {
  const paid = opts.feeCents > 0;
  const amount = money(opts.feeCents, opts.currency);
  const deadline = opts.payDeadline ? formatDeadline(opts.payDeadline) : null;
  const card = paid && !!opts.payUrl;
  const instructions = opts.paymentInstructions
    ? paymentInstructionsText(fillPaymentInstructions(opts.paymentInstructions, opts.refCode))
    : null;

  const nextStepHtml = card
    ? panel(
        t(dict, "registrationPromoted.feePanelTitle", { amount }),
        deadline
          ? t(dict, "registrationPromoted.feeHeldUntil", { deadline })
          : t(dict, "registrationPromoted.feeHeld"),
      ) + button(t(dict, "registrationPromoted.payNow", { amount }), opts.payUrl as string)
    : paid
      ? panel(
          t(dict, "registrationPromoted.feePanelTitle", { amount }),
          instructions ?? t(dict, "registrationPromoted.contactOrganiser"),
        )
      : paragraph(t(dict, "registrationPromoted.noPayment"));

  const nextStepText = card
    ? t(dict, "registrationPromoted.textFee", { amount }) +
      "\n" +
      (deadline
        ? t(dict, "registrationPromoted.textHeldUntil", { deadline })
        : t(dict, "registrationPromoted.textHeld")) +
      "\n" +
      opts.payUrl
    : paid
      ? t(dict, "registrationPromoted.textFee", { amount }) +
        "\n" +
        (instructions ?? t(dict, "registrationPromoted.contactOrganiser"))
      : t(dict, "registrationPromoted.noPayment");

  const subject = t(dict, "registrationPromoted.subject", {
    competitionName: opts.competitionName,
  });
  return {
    subject,
    html: renderEmail({
      subject,
      preheader:
        card && deadline
          ? t(dict, "registrationPromoted.preheaderPay", {
              competitionName: opts.competitionName,
              deadline,
            })
          : t(dict, "registrationPromoted.preheader", {
              competitionName: opts.competitionName,
            }),
      mastheadTag: opts.orgName,
      eyebrow: `${opts.orgName} · ${opts.competitionName}`,
      title: t(dict, "registrationPromoted.title"),
      contentHtml:
        paragraph(
          t(dict, "registrationPromoted.intro", {
            displayName: escapeHtml(opts.displayName),
            competitionName: escapeHtml(opts.competitionName),
          }),
        ) +
        nextStepHtml +
        (opts.refStatusUrl
          ? paragraph(
              t(dict, "registrationPromoted.reference", {
                refCode: escapeHtml(opts.refCode ?? ""),
                url: opts.refStatusUrl,
              }),
            ) + linkFallback(opts.refStatusUrl)
          : ""),
      footerNote: t(dict, "registrationPromoted.footer", {
        competitionName: opts.competitionName,
        orgName: opts.orgName,
      }),
    }),
    text:
      t(dict, "registrationPromoted.textIntro", {
        competitionName: opts.competitionName,
        orgName: opts.orgName,
      }) +
      "\n\n" +
      nextStepText +
      (opts.refStatusUrl
        ? "\n\n" +
          t(dict, "registrationPromoted.textReference", { refCode: opts.refCode ?? "" }) +
          "\n" +
          t(dict, "registrationPromoted.textStatus", { url: opts.refStatusUrl })
        : ""),
  };
}
