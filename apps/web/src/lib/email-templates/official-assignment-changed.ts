import { button, linkFallback, panel, paragraph, renderEmail } from "./compose";
import { t, type Dict } from "@/lib/i18n";
import { fixtureWhen } from "./official-assigned";

export interface OfficialAssignmentChangedArgs {
  orgName: string;
  officialName: string;
  roleKey: string;
  label: string;
  prevAt: string | null;
  nextAt: string | null;
  venueTz: string | null;
  court: string | null;
  venue: string | null;
  meUrl: string;
}

/** A match the official is assigned to moved (PROMPT-57): old vs new slot in
 *  the venue zone, CTA back to /me. Sent for real timetable/venue changes
 *  only, never declined assignments. */
export function officialAssignmentChangedTemplate(
  args: OfficialAssignmentChangedArgs,
  dict: Dict,
): { subject: string; html: string; text: string } {
  const subject = t(dict, "officialChanged.subject", { orgName: args.orgName });
  const where = [args.court, args.venue].filter(Boolean).join(" · ");
  const now = `${fixtureWhen(args.nextAt, args.venueTz)}${where ? ` · ${where}` : ""}`;
  const was = fixtureWhen(args.prevAt, args.venueTz);
  const detail =
    t(dict, "officialChanged.now", { detail: now }) +
    "\n" +
    t(dict, "officialChanged.was", { detail: was });
  return {
    subject,
    html: renderEmail({
      subject,
      preheader: t(dict, "officialChanged.preheader"),
      mastheadTag: args.orgName,
      eyebrow: args.orgName,
      title: t(dict, "officialChanged.title"),
      contentHtml:
        paragraph(
          t(dict, "officialChanged.body", { orgName: args.orgName, role: args.roleKey }),
        ) +
        panel(args.label, detail) +
        button(t(dict, "officialChanged.button"), args.meUrl) +
        linkFallback(args.meUrl),
      footerNote: t(dict, "officialChanged.footer", { orgName: args.orgName }),
    }),
    text:
      t(dict, "officialChanged.text", { orgName: args.orgName, meUrl: args.meUrl }) +
      `\n${args.label}\n${detail}`,
  };
}
