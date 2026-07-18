import { panel, paragraph, renderEmail } from "./compose";
import { escapeHtml, money } from "./shared";
import { t, type Dict } from "@/lib/i18n";

export interface StaffDisputeAlertArgs {
  /** Which platform charge was disputed. */
  kind: "subscription" | "event_pass";
  orgName: string;
  phase: "created" | "closed";
  /** Stripe dispute status (needs_response / won / lost / …). */
  status: string;
  amountCents: number;
  currency: string;
  disputeId: string;
}

/** Internal staff alert (payments-hardening Task 7, decisions §6.2): a PLATFORM
 *  charge — a Pro/Pro Plus subscription invoice or an Event Pass purchase — was
 *  disputed. Unlike a destination-charge dispute there is no transfer to
 *  reverse; recovery is entitlement truth-up, and this mail records what the
 *  webhook already did: flagged (created), cleared (won), auto-downgraded (a
 *  lost subscription) or revoked (a lost pass). Goes to STAFF_ALERT_EMAIL, so
 *  `dict` is the platform locale (en). */
export function staffDisputeAlertTemplate(
  opts: StaffDisputeAlertArgs,
  dict: Dict,
): { subject: string; html: string; text: string } {
  const amount = money(opts.amountCents, opts.currency);
  const kindLabel = t(
    dict,
    opts.kind === "subscription"
      ? "staffDisputeAlert.kind.subscription"
      : "staffDisputeAlert.kind.pass",
  );
  const outcomeKey =
    opts.phase === "created"
      ? "staffDisputeAlert.outcome.created"
      : opts.status === "won"
        ? "staffDisputeAlert.outcome.won"
        : opts.status === "lost"
          ? opts.kind === "subscription"
            ? "staffDisputeAlert.outcome.downgraded"
            : "staffDisputeAlert.outcome.revoked"
          : "staffDisputeAlert.outcome.closed";
  const outcome = t(dict, outcomeKey);
  const subject = t(dict, "staffDisputeAlert.subject", { orgName: opts.orgName, kind: kindLabel });
  return {
    subject,
    html: renderEmail({
      subject,
      preheader: t(dict, "staffDisputeAlert.preheader", {
        amount,
        kind: kindLabel,
        orgName: opts.orgName,
      }),
      mastheadTag: opts.orgName,
      eyebrow: `${opts.orgName} · ${kindLabel}`,
      title: t(dict, "staffDisputeAlert.title"),
      contentHtml:
        paragraph(
          t(dict, "staffDisputeAlert.body", {
            kind: kindLabel,
            orgName: escapeHtml(opts.orgName),
            amount,
            disputeId: escapeHtml(opts.disputeId),
            status: escapeHtml(opts.status),
          }),
        ) + panel(t(dict, "staffDisputeAlert.panelTitle"), outcome),
      footerNote: t(dict, "staffDisputeAlert.footer"),
    }),
    text:
      t(dict, "staffDisputeAlert.textLine", { kind: kindLabel, orgName: opts.orgName }) +
      "\n" +
      t(dict, "staffDisputeAlert.textAmount", {
        amount,
        disputeId: opts.disputeId,
        status: opts.status,
      }) +
      "\n" +
      outcome,
  };
}
