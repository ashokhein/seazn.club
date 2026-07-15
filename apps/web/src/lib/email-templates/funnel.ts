import { button, linkFallback, paragraph, renderEmail } from "./compose";
import { escapeHtml } from "./shared";
import { t, type Dict } from "@/lib/i18n";

export interface FunnelEmailArgs {
  competitionName: string;
  sport: string;
  link: string;
}

/** Funnel claim link (v3/07 §6): the visitor configured a competition on
 *  /start; this single link signs them in AND finishes the setup. `dict` =
 *  emails namespace for the recipient's locale. */
export function funnelClaimTemplate(
  args: FunnelEmailArgs,
  dict: Dict,
): {
  subject: string;
  html: string;
  text: string;
} {
  const subject = t(dict, "funnelClaim.subject", { competitionName: args.competitionName });
  return {
    subject,
    html: renderEmail({
      subject,
      preheader: t(dict, "funnelClaim.preheader"),
      eyebrow: t(dict, "funnelClaim.eyebrow"),
      title: t(dict, "funnelClaim.title", { competitionName: escapeHtml(args.competitionName) }),
      contentHtml:
        paragraph(t(dict, "funnelClaim.body", { sport: escapeHtml(args.sport) })) +
        button(t(dict, "funnelClaim.button"), args.link) +
        linkFallback(args.link),
      footerNote: t(dict, "funnelClaim.footer"),
    }),
    text: t(dict, "funnelClaim.text", { competitionName: args.competitionName, link: args.link }),
  };
}

/** +24h nudge for unclaimed drafts (one per draft, then it expires). */
export function funnelReminderTemplate(
  args: FunnelEmailArgs,
  dict: Dict,
): {
  subject: string;
  html: string;
  text: string;
} {
  const subject = t(dict, "funnelReminder.subject", { competitionName: args.competitionName });
  return {
    subject,
    html: renderEmail({
      subject,
      preheader: t(dict, "funnelReminder.preheader"),
      eyebrow: t(dict, "funnelReminder.eyebrow"),
      title: t(dict, "funnelReminder.title"),
      contentHtml:
        paragraph(
          t(dict, "funnelReminder.body", {
            competitionName: escapeHtml(args.competitionName),
            sport: escapeHtml(args.sport),
          }),
        ) +
        button(t(dict, "funnelReminder.button"), args.link) +
        linkFallback(args.link),
      footerNote: t(dict, "funnelReminder.footer"),
    }),
    text: t(dict, "funnelReminder.text", { competitionName: args.competitionName, link: args.link }),
  };
}
