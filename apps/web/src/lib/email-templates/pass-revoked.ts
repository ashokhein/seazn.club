import { panel, paragraph, renderEmail } from "./compose";
import { escapeHtml } from "./shared";
import { t, type Dict } from "@/lib/i18n";

export interface PassRevokedArgs {
  orgName: string;
  competitionName: string;
}

/** Owner notice when an Event Pass purchase is refunded (console action or a
 *  Stripe-dashboard refund): the pass is revoked and the competition returns to
 *  the plan's active-competition allowance. `dict` = emails namespace; en
 *  default. */
export function passRevokedTemplate(
  opts: PassRevokedArgs,
  dict: Dict,
): { subject: string; html: string; text: string } {
  const subject = t(dict, "passRevoked.subject");
  return {
    subject,
    html: renderEmail({
      subject,
      preheader: t(dict, "passRevoked.preheader", { competitionName: opts.competitionName }),
      mastheadTag: opts.orgName,
      eyebrow: `${opts.orgName} · ${opts.competitionName}`,
      title: t(dict, "passRevoked.title"),
      contentHtml:
        paragraph(
          t(dict, "passRevoked.body", { competitionName: escapeHtml(opts.competitionName) }),
        ) + panel(t(dict, "passRevoked.panelTitle"), t(dict, "passRevoked.panelBody")),
      footerNote: t(dict, "passRevoked.footer", { orgName: opts.orgName }),
    }),
    text:
      t(dict, "passRevoked.text", { competitionName: opts.competitionName }) +
      "\n" +
      t(dict, "passRevoked.textAllowance"),
  };
}
