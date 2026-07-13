import { button, linkFallback, paragraph, renderEmail } from "./compose";
import { escapeHtml } from "./shared";

export interface ClaimInviteArgs {
  orgName: string;
  personName: string;
  claimUrl: string;
}

/** Player-account claim invite (PROMPT-53): the person takes ownership of
 *  their profile — schedule, availability and consent flags. */
export function claimInviteTemplate(args: ClaimInviteArgs): {
  subject: string;
  html: string;
  text: string;
} {
  const subject = `Claim your player profile at ${args.orgName}`;
  return {
    subject,
    html: renderEmail({
      subject,
      preheader: `See your matches, tell organisers when you can play, and control what's public.`,
      mastheadTag: args.orgName,
      eyebrow: args.orgName,
      title: "Claim your player profile",
      contentHtml:
        paragraph(
          `An organiser at <strong>${escapeHtml(args.orgName)}</strong> set up a player profile for <strong>${escapeHtml(args.personName)}</strong>. Claim it to see all your matches in one place, RSVP your availability, and control what appears publicly.`,
        ) +
        button("Claim my profile", args.claimUrl) +
        linkFallback(args.claimUrl),
      footerNote: `You received this because an organiser at ${args.orgName} invited this address. Not you? Just ignore this email.`,
    }),
    text: `Claim your player profile at ${args.orgName}: ${args.claimUrl}`,
  };
}
