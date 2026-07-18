import { button, linkFallback, panel, paragraph, renderEmail } from "./compose";
import { t, type Dict } from "@/lib/i18n";

export interface SuspensionConfirmedArgs {
  orgName: string;
  divisionName: string;
  reason: string;
  matchesTotal: number;
  meUrl: string;
}

/** Localized "N match(es)" phrase — the codebase has no plural engine, so we
 *  pick between two keys on n === 1. */
export function matchesPhrase(dict: Dict, n: number): string {
  return t(dict, n === 1 ? "suspension.match" : "suspension.matches", { n });
}

/** Sent to a claimed player when an organiser CONFIRMS a suspension (SPEC-1) —
 *  never for pending/auto rows. Courtside shell, system font stack (PR #134). */
export function suspensionConfirmedTemplate(
  args: SuspensionConfirmedArgs,
  dict: Dict,
): { subject: string; html: string; text: string } {
  const matches = matchesPhrase(dict, args.matchesTotal);
  const subject = t(dict, "suspensionConfirmed.subject", { division: args.divisionName });
  return {
    subject,
    html: renderEmail({
      subject,
      preheader: t(dict, "suspensionConfirmed.preheader", { matches }),
      mastheadTag: args.orgName,
      eyebrow: `${args.orgName} · ${args.divisionName}`,
      title: t(dict, "suspensionConfirmed.title"),
      contentHtml:
        paragraph(
          t(dict, "suspensionConfirmed.body", {
            org: args.orgName,
            division: args.divisionName,
            reason: args.reason,
            matches,
          }),
        ) +
        panel(args.divisionName, `${args.reason} · ${matches}`) +
        button(t(dict, "suspensionConfirmed.button"), args.meUrl) +
        linkFallback(args.meUrl),
      footerNote: t(dict, "suspensionConfirmed.footer", { division: args.divisionName }),
    }),
    text: t(dict, "suspensionConfirmed.text", {
      org: args.orgName,
      division: args.divisionName,
      reason: args.reason,
      matches,
      meUrl: args.meUrl,
    }),
  };
}
