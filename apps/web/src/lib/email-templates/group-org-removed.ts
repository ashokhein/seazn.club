import { button, linkFallback, paragraph, renderEmail } from "./compose";
import { escapeHtml } from "./shared";
import { t, type Dict } from "@/lib/i18n";

/** Sent to a departing org's OWNER when the group's PAYER pushed it off the
 *  shared bill — the owner did not initiate it and needs to know what happened
 *  to the plan and that its billing is now theirs. Two bodies: `ride_out` keeps
 *  the plan until `ridesOutUntil`, otherwise it is on Community now.
 *  `dict` = emails namespace for the recipient's locale (see lib/email.ts). */
export function groupOrgRemovedTemplate(
  payerName: string,
  orgName: string,
  ridesOutUntil: string | null,
  link: string,
  dict: Dict,
): { subject: string; html: string; text: string } {
  const subject = t(dict, "groupOrgRemoved.subject", { orgName });
  const rides = ridesOutUntil != null;
  const bodyKey = rides ? "groupOrgRemoved.bodyRideOut" : "groupOrgRemoved.bodyCommunity";
  const textKey = rides ? "groupOrgRemoved.textRideOut" : "groupOrgRemoved.textCommunity";
  const htmlParams = {
    payerName: escapeHtml(payerName),
    orgName: escapeHtml(orgName),
    until: ridesOutUntil ? escapeHtml(ridesOutUntil) : "",
  };
  return {
    subject,
    html: renderEmail({
      subject,
      preheader: t(dict, "groupOrgRemoved.preheader", { orgName }),
      mastheadTag: orgName,
      eyebrow: t(dict, "groupOrgRemoved.eyebrow"),
      title: t(dict, "groupOrgRemoved.title", { orgName }),
      contentHtml:
        paragraph(t(dict, bodyKey, htmlParams)) +
        button(t(dict, "groupOrgRemoved.button"), link) +
        linkFallback(link),
      footerNote: t(dict, "groupOrgRemoved.footer", { payerName, orgName }),
    }),
    text: t(dict, textKey, { payerName, orgName, until: ridesOutUntil ?? "", link }),
  };
}
