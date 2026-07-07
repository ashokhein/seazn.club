import { btn, card } from "./shared";

/** Org invite acceptance link. */
export function inviteTemplate(
  orgName: string,
  link: string,
): { subject: string; html: string; text: string } {
  return {
    subject: `You've been invited to join ${orgName} on Seazn Club`,
    html: card(
      `You've been invited to ${orgName}`,
      `You've been invited to join <strong>${orgName}</strong> on Seazn Club. Click below to accept.`,
      btn("Accept invite", link),
      `Or paste: ${link}`,
    ),
    text: `You've been invited to join ${orgName}. Accept: ${link}`,
  };
}
