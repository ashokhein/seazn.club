// Pure breadcrumb derivation for the /o console (v3/01 §3): the trail comes
// entirely from the pathname + the org's slug→name maps — zero per-page
// wiring. Client-safe (no server imports); breadcrumbs.tsx renders it.
import { routes } from "@/lib/routes";
import { msg, type MessageKey } from "@/lib/messages";

export interface Crumb {
  label: string;
  href: string;
}

export interface BreadcrumbNameMap {
  /** compSlug → competition name */
  comps: Record<string, string>;
  /** `${compSlug}/${divSlug}` → division name */
  divs: Record<string, string>;
}

/** Translate function for the fixed structural labels ("Settings",
 *  "Schedule", ...) — breadcrumbs.tsx passes its locale-aware useMsg() so
 *  the trail localizes; defaults to the plain English catalog lookup (same
 *  values the existing tests assert) so buildCrumbs stays pure/testable
 *  without a <DictProvider>. Fixed structural segments only — entity names
 *  (org/competition/division) come from `names`/`orgName`, never through
 *  this catalog. */
export type BreadcrumbT = (key: MessageKey, vars?: Record<string, string | number>) => string;

/** Pages under /o/[org]/settings, by path segment. Anything not listed still
 *  gets a crumb via humanize() — a new settings page must never silently cost
 *  its own trail entry (and with it the back chevron's target). */
const SETTINGS_CHILDREN: Record<string, MessageKey> = {
  billing: "breadcrumb.billing",
  connect: "breadcrumb.connect",
};

/** Fallback when a slug is missing from the map (e.g. created after the
 *  layout rendered): "u16-boys" → "U16 boys". */
function humanize(slug: string): string {
  const words = slug.replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Path → crumb chain. Each crumb links to its level; the last one is the
 * current page. Returns [] for non-console paths.
 */
export function buildCrumbs(args: {
  pathname: string;
  orgName: string;
  names: BreadcrumbNameMap;
  t?: BreadcrumbT;
}): Crumb[] {
  const t = args.t ?? msg;
  const segments = args.pathname.split("/").filter(Boolean);
  if (segments[0] !== "o" || segments.length < 2) return [];
  const org = segments[1] as string;
  const rest = segments.slice(2);
  const crumbs: Crumb[] = [{ label: args.orgName, href: routes.orgHome(org) }];

  if (rest[0] === "settings") {
    crumbs.push({ label: t("breadcrumb.settings"), href: routes.orgSettings(org) });
    // EVERY child, not just billing. A child the chain does not know still gets
    // a crumb (humanized) — the alternative is what /settings/connect had: the
    // "Settings" crumb marked aria-current on a page that is not Settings, and
    // a back chevron aimed past it at org home. #190 removed these pages'
    // hand-rolled "← Settings" links on the grounds that the trail already
    // carried one; for connect it did not.
    const child = rest[1];
    if (child) {
      const known = SETTINGS_CHILDREN[child];
      crumbs.push({
        label: known ? t(known) : humanize(child),
        href: `${routes.orgSettings(org)}/${child}`,
      });
    }
    return crumbs;
  }

  if (rest[0] !== "c" || rest.length < 2) return crumbs;
  if (rest[1] === "new") {
    crumbs.push({ label: t("breadcrumb.newCompetition"), href: routes.competitionNew(org) });
    return crumbs;
  }
  const comp = rest[1] as string;
  crumbs.push({
    label: args.names.comps[comp] ?? humanize(comp),
    href: routes.competition(org, comp),
  });

  const compTail = rest[2];
  if (compTail === "settings" || compTail === "schedule") {
    crumbs.push({
      label: compTail === "settings" ? t("breadcrumb.settings") : t("breadcrumb.schedule"),
      href:
        compTail === "settings"
          ? routes.competitionSettings(org, comp)
          : routes.competitionSchedule(org, comp),
    });
    return crumbs;
  }

  if (compTail !== "d" || rest.length < 4) return crumbs;
  if (rest[3] === "new") {
    crumbs.push({ label: t("breadcrumb.newDivision"), href: routes.divisionNew(org, comp) });
    return crumbs;
  }
  const div = rest[3] as string;
  const divLabel = args.names.divs[`${comp}/${div}`] ?? humanize(div);
  const divTail = rest[4];

  if (divTail === "f" && rest[5]) {
    // Fixture pages: the division crumb goes back to the fixtures tab.
    crumbs.push({ label: divLabel, href: routes.division(org, comp, div, "fixtures") });
    crumbs.push({
      label: t("breadcrumb.match", { no: rest[5] }),
      href: routes.fixture(org, comp, div, Number(rest[5])),
    });
    return crumbs;
  }

  crumbs.push({ label: divLabel, href: routes.division(org, comp, div) });
  if (divTail === "schedule") {
    crumbs.push({ label: t("breadcrumb.schedule"), href: routes.divisionSchedule(org, comp, div) });
  } else if (divTail === "registrations") {
    crumbs.push({ label: t("breadcrumb.registrations"), href: routes.divisionRegistrations(org, comp, div) });
  }
  return crumbs;
}
