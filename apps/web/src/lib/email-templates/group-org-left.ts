import { button, linkFallback, paragraph, renderEmail } from "./compose";
import { escapeHtml } from "./shared";
import { t, type Dict } from "@/lib/i18n";

/** Sent to the PAYER when an org's own OWNER pulled it out of the group — the
 *  payer did not initiate it and their next invoice changes. Two bodies:
 *  `seatFreed` (release) kept the seat as a reusable slot; otherwise (ride_out)
 *  the seat left with the org and the next invoice is one smaller.
 *  `dict` = emails namespace for the recipient's locale (see lib/email.ts). */
export function groupOrgLeftTemplate(
  orgName: string,
  seatFreed: boolean,
  link: string,
  dict: Dict,
): { subject: string; html: string; text: string } {
  const subject = t(dict, "groupOrgLeft.subject", { orgName });
  const bodyKey = seatFreed ? "groupOrgLeft.bodyFreed" : "groupOrgLeft.bodySpent";
  const textKey = seatFreed ? "groupOrgLeft.textFreed" : "groupOrgLeft.textSpent";
  return {
    subject,
    html: renderEmail({
      subject,
      preheader: t(dict, "groupOrgLeft.preheader", { orgName }),
      mastheadTag: orgName,
      eyebrow: t(dict, "groupOrgLeft.eyebrow"),
      title: t(dict, "groupOrgLeft.title", { orgName }),
      contentHtml:
        paragraph(t(dict, bodyKey, { orgName: escapeHtml(orgName) })) +
        button(t(dict, "groupOrgLeft.button"), link) +
        linkFallback(link),
      footerNote: t(dict, "groupOrgLeft.footer"),
    }),
    text: t(dict, textKey, { orgName, link }),
  };
}
