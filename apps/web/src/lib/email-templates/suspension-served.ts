import { button, linkFallback, paragraph, renderEmail } from "./compose";
import { t, type Dict } from "@/lib/i18n";

export interface SuspensionServedArgs {
  orgName: string;
  divisionName: string;
  reason: string;
  meUrl: string;
}

/** Sent to a claimed player when a suspension flips to `served` — they're clear
 *  to play again (SPEC-1). Unclaimed persons have no address rail, no email. */
export function suspensionServedTemplate(
  args: SuspensionServedArgs,
  dict: Dict,
): { subject: string; html: string; text: string } {
  const subject = t(dict, "suspensionServed.subject", { division: args.divisionName });
  return {
    subject,
    html: renderEmail({
      subject,
      preheader: t(dict, "suspensionServed.preheader"),
      mastheadTag: args.orgName,
      eyebrow: `${args.orgName} · ${args.divisionName}`,
      title: t(dict, "suspensionServed.title"),
      contentHtml:
        paragraph(
          t(dict, "suspensionServed.body", { division: args.divisionName, reason: args.reason }),
        ) +
        button(t(dict, "suspensionServed.button"), args.meUrl) +
        linkFallback(args.meUrl),
      footerNote: t(dict, "suspensionServed.footer", { division: args.divisionName }),
    }),
    text: t(dict, "suspensionServed.text", {
      division: args.divisionName,
      reason: args.reason,
      meUrl: args.meUrl,
    }),
  };
}
