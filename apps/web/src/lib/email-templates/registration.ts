import { button, linkFallback, panel, paragraph, renderEmail } from "./compose";
import { escapeHtml, money } from "./shared";

export interface RegistrationEmailArgs {
  orgName: string;
  competitionName: string;
  displayName: string;
  status: string; // pending | waitlisted | ...
  feeCents: number;
  currency: string;
  paymentInstructions: string | null;
  statusUrl: string;
}

/** Registration confirmation — carries the offline (cash/bank) payment
 *  instructions for paid entries. */
export function registrationTemplate(
  opts: RegistrationEmailArgs,
): { subject: string; html: string; text: string } {
  const waitlisted = opts.status === "waitlisted";
  const paid = opts.feeCents > 0 && !waitlisted;
  const intro = waitlisted
    ? `You're on the waitlist for <strong>${escapeHtml(opts.competitionName)}</strong>. We'll be in touch if a place opens up.`
    : `Thanks ${escapeHtml(opts.displayName)} — your registration for <strong>${escapeHtml(opts.competitionName)}</strong> has been received.`;

  const paymentBlock =
    paid && opts.paymentInstructions
      ? panel(`Entry fee: ${money(opts.feeCents, opts.currency)}`, opts.paymentInstructions)
      : paid
        ? paragraph(
            `Entry fee: <strong>${money(opts.feeCents, opts.currency)}</strong>. The organiser will contact you with payment details.`,
          )
        : "";

  const paymentText =
    paid && opts.paymentInstructions
      ? `\n\nEntry fee: ${money(opts.feeCents, opts.currency)}\nHow to pay:\n${opts.paymentInstructions}`
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
        paymentBlock +
        button("View your registration", opts.statusUrl) +
        linkFallback(opts.statusUrl),
      footerNote: `You received this because this address was used to enter ${opts.competitionName} at ${opts.orgName}.`,
    }),
    text:
      `${waitlisted ? "You're on the waitlist" : "Registration received"} for ${opts.competitionName} (${opts.orgName}).` +
      paymentText +
      `\n\nView your registration: ${opts.statusUrl}`,
  };
}
