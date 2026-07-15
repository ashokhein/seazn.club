import { button, linkFallback, paragraph, renderEmail } from "./compose";
import { escapeHtml } from "./shared";
import { t, type Dict } from "@/lib/i18n";

export interface ClaimInviteArgs {
  orgName: string;
  personName: string;
  claimUrl: string;
}

/** Player-account claim invite (PROMPT-53): the person takes ownership of
 *  their profile — schedule, availability and consent flags. `dict` = emails
 *  namespace for the recipient's locale. */
export function claimInviteTemplate(
  args: ClaimInviteArgs,
  dict: Dict,
): {
  subject: string;
  html: string;
  text: string;
} {
  const subject = t(dict, "claimInvite.subject", { orgName: args.orgName });
  return {
    subject,
    html: renderEmail({
      subject,
      preheader: t(dict, "claimInvite.preheader"),
      mastheadTag: args.orgName,
      eyebrow: args.orgName,
      title: t(dict, "claimInvite.title"),
      contentHtml:
        paragraph(
          t(dict, "claimInvite.body", {
            orgName: escapeHtml(args.orgName),
            personName: escapeHtml(args.personName),
          }),
        ) +
        button(t(dict, "claimInvite.button"), args.claimUrl) +
        linkFallback(args.claimUrl),
      footerNote: t(dict, "claimInvite.footer", { orgName: args.orgName }),
    }),
    text: t(dict, "claimInvite.text", { orgName: args.orgName, claimUrl: args.claimUrl }),
  };
}
