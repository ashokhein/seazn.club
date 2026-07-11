import { button, linkFallback, paragraph, renderEmail } from "./compose";

export interface FunnelEmailArgs {
  competitionName: string;
  sport: string;
  link: string;
}

/** Funnel claim link (v3/07 §6): the visitor configured a competition on
 *  /start; this single link signs them in AND finishes the setup. */
export function funnelClaimTemplate(args: FunnelEmailArgs): {
  subject: string;
  html: string;
  text: string;
} {
  const subject = `“${args.competitionName}” is ready to finish setting up`;
  return {
    subject,
    html: renderEmail({
      subject,
      preheader: "One click creates your competition and takes you inside.",
      eyebrow: "Your competition",
      title: `${args.competitionName} is one click away`,
      contentHtml:
        paragraph(
          `Your ${escapeHtml(args.sport)} competition is drafted and waiting. ` +
            "Click below to create it and land straight on the entrant list — " +
            "no password needed, this link signs you in.",
        ) +
        button("Finish setting up", args.link) +
        linkFallback(args.link),
      footerNote:
        "The link works once and expires in 7 days. If you didn't request this, you can safely ignore it.",
    }),
    text: `Finish setting up “${args.competitionName}” (link works once, expires in 7 days): ${args.link}`,
  };
}

/** +24h nudge for unclaimed drafts (one per draft, then it expires). */
export function funnelReminderTemplate(args: FunnelEmailArgs): {
  subject: string;
  html: string;
  text: string;
} {
  const subject = `Still planning “${args.competitionName}”?`;
  return {
    subject,
    html: renderEmail({
      subject,
      preheader: "Your drafted competition expires in a few days.",
      eyebrow: "Reminder",
      title: "Your competition is still waiting",
      contentHtml:
        paragraph(
          `You drafted “${escapeHtml(args.competitionName)}” (${escapeHtml(args.sport)}) ` +
            "yesterday but haven't finished setting it up. One click signs you in and creates it.",
        ) +
        button("Finish setting up", args.link) +
        linkFallback(args.link),
      footerNote: "This is the only reminder we'll send — the draft expires 7 days after it was created.",
    }),
    text: `Finish setting up “${args.competitionName}”: ${args.link}`,
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
