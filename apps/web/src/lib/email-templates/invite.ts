import { button, linkFallback, paragraph, renderEmail } from "./compose";
import { escapeHtml } from "./shared";

/** Org invite acceptance link. */
export function inviteTemplate(
  orgName: string,
  link: string,
): { subject: string; html: string; text: string } {
  return {
    subject: `You've been invited to join ${orgName} on Seazn Club`,
    html: renderEmail({
      subject: `You've been invited to join ${orgName} on Seazn Club`,
      preheader: `Accept your invite to ${orgName} and get involved.`,
      mastheadTag: orgName,
      eyebrow: orgName,
      title: "You're invited",
      contentHtml:
        paragraph(
          `You've been invited to join <strong>${escapeHtml(orgName)}</strong> on Seazn Club. Click below to accept.`,
        ) +
        button("Accept invite", link) +
        linkFallback(link),
      footerNote: `You received this because an organiser at ${orgName} invited this address.`,
    }),
    text: `You've been invited to join ${orgName}. Accept: ${link}`,
  };
}
