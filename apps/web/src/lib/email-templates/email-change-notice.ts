import { card } from "./shared";

/** Security notice to the OLD address when an email change is requested. */
export function emailChangeNoticeTemplate(newEmail: string): { subject: string; html: string; text: string } {
  return {
    subject: "Your Seazn Club email address is being changed",
    html: card(
      "Your email address is being changed",
      `Someone requested a change to the email address on your account to <strong>${newEmail}</strong>. The change will take effect once the new address is confirmed. If this wasn't you, contact support immediately.`,
      "",
      "",
    ),
    text: `Your account email is being changed to ${newEmail}. If this wasn't you, contact support.`,
  };
}
