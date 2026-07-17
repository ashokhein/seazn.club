import { button, linkFallback, paragraph, renderEmail } from "./compose";
import { escapeHtml } from "./shared";
import { t, type Dict } from "@/lib/i18n";

export interface OfficialInviteArgs {
  orgName: string;
  personName: string;
  claimUrl: string;
}

/** Officiating claim invite (PROMPT-57): same claim rail as players, distinct
 *  copy — the recipient is a referee/umpire, not a player. `dict` = emails
 *  namespace for the recipient's locale. */
export function officialInviteTemplate(
  args: OfficialInviteArgs,
  dict: Dict,
): {
  subject: string;
  html: string;
  text: string;
} {
  const subject = t(dict, "officialInvite.subject", { orgName: args.orgName });
  return {
    subject,
    html: renderEmail({
      subject,
      preheader: t(dict, "officialInvite.preheader"),
      mastheadTag: args.orgName,
      eyebrow: args.orgName,
      title: t(dict, "officialInvite.title"),
      contentHtml:
        paragraph(
          t(dict, "officialInvite.body", {
            orgName: escapeHtml(args.orgName),
            personName: escapeHtml(args.personName),
          }),
        ) +
        button(t(dict, "officialInvite.button"), args.claimUrl) +
        linkFallback(args.claimUrl),
      footerNote: t(dict, "officialInvite.footer", { orgName: args.orgName }),
    }),
    text: t(dict, "officialInvite.text", { orgName: args.orgName, claimUrl: args.claimUrl }),
  };
}
