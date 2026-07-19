import { button, linkFallback, panel, paragraph, renderEmail } from "./compose";
import { t, type Dict } from "@/lib/i18n";

export interface ReportSubmittedArgs {
  orgName: string;
  fixtureLine: string;
  officialName: string;
  incidentCount: number;
  /** Deep link to the fixture's officials panel (built by the sender). */
  url: string;
}

/** Localized "N incident(s)" phrase — no plural engine, so pick on n === 1
 *  (n === 0 reads "0 incidents flagged", which is fine). */
export function incidentsPhrase(dict: Dict, n: number): string {
  return t(dict, n === 1 ? "reportSubmitted.incident" : "reportSubmitted.incidents", { n });
}

/** Sent to an org's owner/admins when an official submits a match report
 *  (SPEC-3) — fixture line, official name, incident count, deep link. Courtside
 *  shell, system font stack (PR #134). No email fires for marks (D4). */
export function reportSubmittedTemplate(
  args: ReportSubmittedArgs,
  dict: Dict,
): { subject: string; html: string; text: string } {
  const incidents = incidentsPhrase(dict, args.incidentCount);
  const subject = t(dict, "reportSubmitted.subject", { fixture: args.fixtureLine });
  return {
    subject,
    html: renderEmail({
      subject,
      preheader: t(dict, "reportSubmitted.preheader", { official: args.officialName, incidents }),
      mastheadTag: args.orgName,
      eyebrow: args.orgName,
      title: t(dict, "reportSubmitted.title"),
      contentHtml:
        paragraph(
          t(dict, "reportSubmitted.body", {
            official: args.officialName,
            fixture: args.fixtureLine,
            incidents,
          }),
        ) +
        panel(args.fixtureLine, `${args.officialName} · ${incidents}`) +
        button(t(dict, "reportSubmitted.button"), args.url) +
        linkFallback(args.url),
      footerNote: t(dict, "reportSubmitted.footer"),
    }),
    text: t(dict, "reportSubmitted.text", {
      official: args.officialName,
      fixture: args.fixtureLine,
      incidents,
      url: args.url,
    }),
  };
}
