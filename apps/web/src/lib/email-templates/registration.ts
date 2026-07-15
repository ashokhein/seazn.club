import { button, linkFallback, panel, paragraph, renderEmail } from "./compose";
import { escapeHtml, money } from "./shared";
import { t, type Dict } from "@/lib/i18n";
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
 *  instructions for paid entries. `dict` = emails namespace for the
 *  recipient's locale (see lib/email.ts senders). */
export function registrationTemplate(
  opts: RegistrationEmailArgs,
  dict: Dict,
): { subject: string; html: string; text: string } {
  const waitlisted = opts.status === "waitlisted";
  const paid = opts.feeCents > 0 && !waitlisted;
  const amount = money(opts.feeCents, opts.currency);
  // Markdown instructions → plain text for the panel, with the registrant's
  // reference substituted for {{reference}}.
  const instructions = opts.paymentInstructions
    ? paymentInstructionsText(fillPaymentInstructions(opts.paymentInstructions, opts.refCode))
    : null;
  const intro = waitlisted
    ? t(dict, "registration.introWaitlist", { competitionName: escapeHtml(opts.competitionName) })
    : t(dict, "registration.intro", {
        displayName: escapeHtml(opts.displayName),
        competitionName: escapeHtml(opts.competitionName),
      });

  const card = paid && !!opts.payUrl;
  const deadline = opts.payDeadline ? formatDeadline(opts.payDeadline) : null;

  const paymentBlock = card
    ? panel(
        t(dict, "registration.feePanelTitle", { amount }),
        deadline
          ? t(dict, "registration.feeHeldUntil", { deadline })
          : t(dict, "registration.feeHeld"),
      ) + button(t(dict, "registration.payNow", { amount }), opts.payUrl as string)
    : paid && instructions
      ? panel(t(dict, "registration.feePanelTitle", { amount }), instructions as string)
      : paid
        ? paragraph(t(dict, "registration.feeContactOrganiser", { amount }))
        : "";

  const paymentText = card
    ? "\n\n" +
      t(dict, "registration.textFee", { amount }) +
      "\n" +
      (deadline
        ? t(dict, "registration.textHeldUntil", { deadline })
        : t(dict, "registration.textHeld")) +
      "\n" +
      opts.payUrl
    : paid && instructions
      ? "\n\n" +
        t(dict, "registration.textFee", { amount }) +
        "\n" +
        t(dict, "registration.textHowToPay") +
        "\n" +
        instructions
      : paid
        ? "\n\n" + t(dict, "registration.textFeeContactOrganiser", { amount })
        : "";

  const subject = t(dict, "registration.subject", { competitionName: opts.competitionName });
  return {
    subject,
    html: renderEmail({
      subject,
      preheader: waitlisted
        ? t(dict, "registration.preheaderWaitlist", { competitionName: opts.competitionName })
        : paid
          ? t(dict, "registration.preheaderPaid", { competitionName: opts.competitionName })
          : t(dict, "registration.preheaderFree", { competitionName: opts.competitionName }),
      mastheadTag: opts.orgName,
      eyebrow: `${opts.orgName} · ${opts.competitionName}`,
      title: waitlisted
        ? t(dict, "registration.titleWaitlist")
        : t(dict, "registration.title"),
      contentHtml:
        paragraph(intro) +
        (opts.refCode
          ? panel(
              t(dict, "registration.refPanelTitle", { refCode: opts.refCode }),
              opts.refStatusUrl
                ? t(dict, "registration.refPanelBodyAt", { url: opts.refStatusUrl })
                : t(dict, "registration.refPanelBody"),
            )
          : "") +
        paymentBlock +
        button(t(dict, "registration.viewButton"), opts.statusUrl) +
        linkFallback(opts.statusUrl),
      footerNote: t(dict, "registration.footer", {
        competitionName: opts.competitionName,
        orgName: opts.orgName,
      }),
    }),
    text:
      (waitlisted
        ? t(dict, "registration.textIntroWaitlist", {
            competitionName: opts.competitionName,
            orgName: opts.orgName,
          })
        : t(dict, "registration.textIntro", {
            competitionName: opts.competitionName,
            orgName: opts.orgName,
          })) +
      (opts.refCode
        ? "\n\n" +
          t(dict, "registration.textRef", { refCode: opts.refCode }) +
          (opts.refStatusUrl
            ? "\n" + t(dict, "registration.textRefStatus", { url: opts.refStatusUrl })
            : "")
        : "") +
      paymentText +
      "\n\n" +
      t(dict, "registration.textView", { url: opts.statusUrl }),
  };
}
