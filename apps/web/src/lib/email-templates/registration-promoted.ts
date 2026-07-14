import { button, linkFallback, panel, paragraph, renderEmail } from "./compose";
import { escapeHtml, money } from "./shared";
import { formatDeadline } from "./registration";
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
 *  entries pay inside the fresh window, offline entries follow instructions. */
export function registrationPromotedTemplate(
  opts: RegistrationPromotedArgs,
): { subject: string; html: string; text: string } {
  const paid = opts.feeCents > 0;
  const deadline = opts.payDeadline ? formatDeadline(opts.payDeadline) : null;
  const card = paid && !!opts.payUrl;
  const instructions = opts.paymentInstructions
    ? paymentInstructionsText(fillPaymentInstructions(opts.paymentInstructions, opts.refCode))
    : null;

  const nextStepHtml = card
    ? panel(
        `Entry fee: ${money(opts.feeCents, opts.currency)}`,
        `Your spot is held${deadline ? ` until ${deadline}` : ""} — complete payment to confirm it. Miss the window and the next person in line is offered the place.`,
      ) + button(`Pay now — ${money(opts.feeCents, opts.currency)}`, opts.payUrl as string)
    : paid
      ? panel(
          `Entry fee: ${money(opts.feeCents, opts.currency)}`,
          instructions ?? "The organiser will contact you with payment details.",
        )
      : paragraph("No payment is needed — the organiser will confirm your entry.");

  const nextStepText = card
    ? `Entry fee: ${money(opts.feeCents, opts.currency)}\nYour spot is held${deadline ? ` until ${deadline}` : ""} — pay to confirm it:\n${opts.payUrl}`
    : paid
      ? `Entry fee: ${money(opts.feeCents, opts.currency)}\n${instructions ?? "The organiser will contact you with payment details."}`
      : "No payment is needed — the organiser will confirm your entry.";

  return {
    subject: `A spot opened up — ${opts.competitionName}`,
    html: renderEmail({
      subject: `A spot opened up — ${opts.competitionName}`,
      preheader: `You're off the waitlist for ${opts.competitionName}${card && deadline ? ` — pay by ${deadline}` : ""}.`,
      mastheadTag: opts.orgName,
      eyebrow: `${opts.orgName} · ${opts.competitionName}`,
      title: "You're off the waitlist",
      contentHtml:
        paragraph(
          `Good news, ${escapeHtml(opts.displayName)} — a place opened up in <strong>${escapeHtml(opts.competitionName)}</strong> and it's yours.`,
        ) +
        nextStepHtml +
        (opts.refStatusUrl
          ? paragraph(
              `Your reference is <strong>${escapeHtml(opts.refCode ?? "")}</strong> — check your status any time at ${opts.refStatusUrl}.`,
            ) + linkFallback(opts.refStatusUrl)
          : ""),
      footerNote: `You received this because this address was used to enter ${opts.competitionName} at ${opts.orgName}.`,
    }),
    text:
      `You're off the waitlist for ${opts.competitionName} (${opts.orgName}).\n\n` +
      nextStepText +
      (opts.refStatusUrl ? `\n\nYour reference: ${opts.refCode}\nStatus: ${opts.refStatusUrl}` : ""),
  };
}
