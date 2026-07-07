import { card } from "./shared";

/** Confirmation that an account was scheduled for deletion. */
export function accountDeletionTemplate(): { subject: string; html: string; text: string } {
  return {
    subject: "Your Seazn Club account has been deleted",
    html: card(
      "Your account has been deleted",
      "Your Seazn Club account and associated data have been scheduled for permanent deletion within 30 days. If this wasn't you, contact support immediately.",
      "",
      "",
    ),
    text: "Your Seazn Club account has been deleted. Data will be erased within 30 days.",
  };
}
