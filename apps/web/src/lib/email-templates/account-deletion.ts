import { paragraph, renderEmail } from "./compose";

/** Confirmation that an account was scheduled for deletion. */
export function accountDeletionTemplate(): { subject: string; html: string; text: string } {
  const subject = "Your Seazn Club account has been deleted";
  return {
    subject,
    html: renderEmail({
      subject,
      preheader: "Your account and data are scheduled for permanent deletion within 30 days.",
      eyebrow: "Account",
      title: "Your account has been deleted",
      contentHtml: paragraph(
        "Your Seazn Club account and associated data have been scheduled for permanent deletion within 30 days. " +
          "If this wasn't you, contact support immediately.",
      ),
      footerNote: "This is the last email we'll send to this address.",
    }),
    text: "Your Seazn Club account has been deleted. Data will be erased within 30 days.",
  };
}
