import { button, linkFallback, panel, paragraph, renderEmail } from "./compose";
import { escapeHtml, money } from "./shared";
import {
  fillPaymentInstructions,
  paymentInstructionsText,
} from "@/lib/payment-instructions";

export interface RegistrationEmailArgs {
  orgName: string;
  competitionName: string;
  displayName: string;
  status: string; // pending | waitlisted | ...
  feeCents: number;
  currency: string;
  paymentInstructions: string | null;
  /** Card entries (spec §3): direct pay link + the 48h deadline. */
  payUrl?: string | null;
  payDeadline?: Date | string | null;
  statusUrl: string;
  /** Quotable reference (v3/05 §3) + its public status page. */
  refCode?: string | null;
  refStatusUrl?: string | null;
}

export function formatDeadline(d: Date | string): string {
  return new Date(d).toLocaleString("en-GB", {
    weekday: "short", day: "numeric", month: "short",
    hour: "2-digit", minute: "2-digit", timeZone: "UTC", timeZoneName: "short",
  });
}

/** Registration confirmation — carries the offline (cash/bank) payment
 *  instructions for paid entries. */
export function registrationTemplate(
  opts: RegistrationEmailArgs,
): { subject: string; html: string; text: string } {
  const waitlisted = opts.status === "waitlisted";
  const paid = opts.feeCents > 0 && !waitlisted;
  // Markdown instructions → plain text for the panel, with the registrant's
  // reference substituted for {{reference}}.
  const instructions = opts.paymentInstructions
    ? paymentInstructionsText(fillPaymentInstructions(opts.paymentInstructions, opts.refCode))
    : null;
  const intro = waitlisted
    ? `You're on the waitlist for <strong>${escapeHtml(opts.competitionName)}</strong>. We'll be in touch if a place opens up.`
    : `Thanks ${escapeHtml(opts.displayName)} — your registration for <strong>${escapeHtml(opts.competitionName)}</strong> has been received.`;

  const card = paid && !!opts.payUrl;
  const deadline = opts.payDeadline ? formatDeadline(opts.payDeadline) : null;

  const paymentBlock = card
    ? panel(
        `Entry fee: ${money(opts.feeCents, opts.currency)}`,
        `Your spot is held${deadline ? ` until ${deadline}` : ""} — complete payment to confirm it.`,
      ) + button(`Pay now — ${money(opts.feeCents, opts.currency)}`, opts.payUrl as string)
    : paid && instructions
      ? panel(`Entry fee: ${money(opts.feeCents, opts.currency)}`, instructions as string)
      : paid
        ? paragraph(
            `Entry fee: <strong>${money(opts.feeCents, opts.currency)}</strong>. The organiser will contact you with payment details.`,
          )
        : "";

  const paymentText = card
    ? `\n\nEntry fee: ${money(opts.feeCents, opts.currency)}` +
      `\nYour spot is held${deadline ? ` until ${deadline}` : ""} — pay to confirm it:\n${opts.payUrl}`
    : paid && instructions
      ? `\n\nEntry fee: ${money(opts.feeCents, opts.currency)}\nHow to pay:\n${instructions}`
      : paid
        ? `\n\nEntry fee: ${money(opts.feeCents, opts.currency)}. The organiser will contact you with payment details.`
        : "";

  return {
    subject: `Registration received — ${opts.competitionName}`,
    html: renderEmail({
      subject: `Registration received — ${opts.competitionName}`,
      preheader: waitlisted
        ? `You're on the waitlist for ${opts.competitionName} — we'll be in touch.`
        : `Your entry for ${opts.competitionName} is in${paid ? " — payment details inside" : ""}.`,
      mastheadTag: opts.orgName,
      eyebrow: `${opts.orgName} · ${opts.competitionName}`,
      title: waitlisted ? "You're on the waitlist" : "Registration received",
      contentHtml:
        paragraph(intro) +
        (opts.refCode
          ? panel(
              `Your reference: ${escapeHtml(opts.refCode)}`,
              "Quote it to the organiser or look yourself up on the day" +
                (opts.refStatusUrl ? ` at ${opts.refStatusUrl}` : "") +
                ".",
            )
          : "") +
        paymentBlock +
        button("View your registration", opts.statusUrl) +
        linkFallback(opts.statusUrl),
      footerNote: `You received this because this address was used to enter ${opts.competitionName} at ${opts.orgName}.`,
    }),
    text:
      `${waitlisted ? "You're on the waitlist" : "Registration received"} for ${opts.competitionName} (${opts.orgName}).` +
      (opts.refCode
        ? `\n\nYour reference: ${opts.refCode}` +
          (opts.refStatusUrl ? `\nCheck your status: ${opts.refStatusUrl}` : "")
        : "") +
      paymentText +
      `\n\nView your registration: ${opts.statusUrl}`,
  };
}
