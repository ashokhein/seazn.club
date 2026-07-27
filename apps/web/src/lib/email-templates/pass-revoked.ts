import { panel, paragraph, renderEmail } from "./compose";
import { escapeHtml } from "./shared";
import { t, type Dict } from "@/lib/i18n";
import type { PassKey } from "@/lib/currency";
import type { DictionaryKey } from "@/lib/i18n-keys";

/** The rung's own name, in the emails namespace (the app's `upgrade.rung.*`
 *  lives in `ui`). `Record<PassKey, …>` for the same reason as the staff dispute
 *  alert's KIND_LABEL_KEY: a rung added to PASS_KEYS without a label here is a
 *  compile error, not a $59 refund described to the buyer as the $29 product. */
const RUNG_NAME_KEY: Record<PassKey, DictionaryKey> = {
  event_pass: "passRevoked.rung.m",
  event_pass_l: "passRevoked.rung.l",
};

export interface PassRevokedArgs {
  orgName: string;
  competitionName: string;
  /**
   * WHICH rung was refunded (v17 #294).
   *
   * Required, and read from `competition_passes.pass_key` BEFORE the revoke
   * deletes the row — the only moment it is still available. Without it this
   * mail said "Your Event Pass was refunded" to an org that had paid $59 for an
   * Event Pass L, naming the other product in the one message whose whole job
   * is telling them what they got their money back for.
   */
  passKey: PassKey;
}

/** Owner notice when an Event Pass purchase is refunded (console action or a
 *  Stripe-dashboard refund): the pass is revoked and the competition returns to
 *  the plan's active-competition allowance. `dict` = emails namespace; en
 *  default. */
export function passRevokedTemplate(
  opts: PassRevokedArgs,
  dict: Dict,
): { subject: string; html: string; text: string } {
  // Interpolated into the subject, the preheader, the title, the body AND the
  // plain-text part: a reader who only sees the subject line and a reader who
  // only gets the text fallback must both learn the same thing.
  const rung = t(dict, RUNG_NAME_KEY[opts.passKey]);
  const subject = t(dict, "passRevoked.subject", { rung });
  return {
    subject,
    html: renderEmail({
      subject,
      preheader: t(dict, "passRevoked.preheader", {
        rung,
        competitionName: opts.competitionName,
      }),
      mastheadTag: opts.orgName,
      eyebrow: `${opts.orgName} · ${opts.competitionName}`,
      title: t(dict, "passRevoked.title", { rung }),
      contentHtml:
        paragraph(
          t(dict, "passRevoked.body", {
            rung,
            competitionName: escapeHtml(opts.competitionName),
          }),
        ) + panel(t(dict, "passRevoked.panelTitle"), t(dict, "passRevoked.panelBody")),
      footerNote: t(dict, "passRevoked.footer", { orgName: opts.orgName }),
    }),
    text:
      t(dict, "passRevoked.text", { rung, competitionName: opts.competitionName }) +
      "\n" +
      t(dict, "passRevoked.textAllowance"),
  };
}
