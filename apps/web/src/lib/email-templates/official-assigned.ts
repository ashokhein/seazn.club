import { button, linkFallback, panel, paragraph, renderEmail } from "./compose";
import { t, type Dict } from "@/lib/i18n";

export interface OfficialAssignedArgs {
  orgName: string;
  officialName: string;
  meUrl: string;
  fixtures: {
    label: string;
    role_key: string;
    scheduled_at: string | null;
    /** Venue zone; emails can't know the reader's zone, so times are always
     *  rendered in the venue zone WITH the zone labelled. */
    venue_tz: string | null;
    venue: string | null;
    court_label: string | null;
  }[];
}

/** Venue-zone datetime with the zone labelled ("TBC" when unscheduled). */
export function fixtureWhen(at: string | null, tz: string | null): string {
  if (!at) return "TBC";
  const zone = tz ?? "UTC";
  try {
    const s = new Date(at).toLocaleString("en-GB", {
      timeZone: zone,
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
    return `${s} (${zone})`;
  } catch {
    return `${new Date(at).toISOString()} (UTC)`;
  }
}

/** New officiating assignment(s) (PROMPT-57): one panel per match, CTA to the
 *  /me officiating lane where accept/decline lives. Default locale en —
 *  officials have no stored locale (registrations.locale precedent). */
export function officialAssignedTemplate(
  args: OfficialAssignedArgs,
  dict: Dict,
): { subject: string; html: string; text: string } {
  const subject = t(dict, "officialAssigned.subject", { orgName: args.orgName });
  const lines = args.fixtures.map((f) => {
    const where = [f.court_label, f.venue].filter(Boolean).join(" · ");
    return {
      title: f.label,
      body: `${f.role_key} · ${fixtureWhen(f.scheduled_at, f.venue_tz)}${where ? ` · ${where}` : ""}`,
    };
  });
  return {
    subject,
    html: renderEmail({
      subject,
      preheader: t(dict, "officialAssigned.preheader"),
      mastheadTag: args.orgName,
      eyebrow: args.orgName,
      title: t(dict, "officialAssigned.title"),
      contentHtml:
        paragraph(t(dict, "officialAssigned.body", { orgName: args.orgName })) +
        lines.map((l) => panel(l.title, l.body)).join("") +
        button(t(dict, "officialAssigned.button"), args.meUrl) +
        linkFallback(args.meUrl),
      footerNote: t(dict, "officialAssigned.footer", { orgName: args.orgName }),
    }),
    text:
      t(dict, "officialAssigned.text", { orgName: args.orgName, meUrl: args.meUrl }) +
      "\n" +
      lines.map((l) => `- ${l.title}: ${l.body}`).join("\n"),
  };
}
