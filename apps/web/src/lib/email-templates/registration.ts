import { btn, card, escapeHtml, money } from "./shared";

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
    ? `You're on the waitlist for <strong>${opts.competitionName}</strong>. We'll be in touch if a place opens up.`
    : `Thanks ${opts.displayName} — your registration for <strong>${opts.competitionName}</strong> has been received.`;

  const paymentBlock =
    paid && opts.paymentInstructions
      ? `<div style="margin:16px 0;padding:16px;border:1px solid #e9d5ff;border-radius:12px;background:#faf5ff">
           <p style="margin:0 0 8px;color:#6b21a8;font-weight:600">Entry fee: ${money(opts.feeCents, opts.currency)}</p>
           <p style="margin:0;color:#334155;white-space:pre-line">${escapeHtml(opts.paymentInstructions)}</p>
         </div>`
      : paid
        ? `<p style="color:#334155">Entry fee: <strong>${money(opts.feeCents, opts.currency)}</strong>. The organiser will contact you with payment details.</p>`
        : "";

  const paymentText =
    paid && opts.paymentInstructions
      ? `\n\nEntry fee: ${money(opts.feeCents, opts.currency)}\nHow to pay:\n${opts.paymentInstructions}`
      : paid
        ? `\n\nEntry fee: ${money(opts.feeCents, opts.currency)}. The organiser will contact you with payment details.`
        : "";

  return {
    subject: `Registration received — ${opts.competitionName}`,
    html: card(
      "Registration received",
      intro,
      paymentBlock + btn("View your registration", opts.statusUrl),
      `Or paste: ${opts.statusUrl}`,
    ),
    text:
      `${waitlisted ? "You're on the waitlist" : "Registration received"} for ${opts.competitionName} (${opts.orgName}).` +
      paymentText +
      `\n\nView your registration: ${opts.statusUrl}`,
  };
}
