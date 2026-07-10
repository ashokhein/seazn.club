// Pure breadcrumb derivation for the /o console (v3/01 §3): the trail comes
// entirely from the pathname + the org's slug→name maps — zero per-page
// wiring. Client-safe (no server imports); breadcrumbs.tsx renders it.
import { routes } from "@/lib/routes";

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
}): Crumb[] {
  const segments = args.pathname.split("/").filter(Boolean);
  if (segments[0] !== "o" || segments.length < 2) return [];
  const org = segments[1] as string;
  const rest = segments.slice(2);
  const crumbs: Crumb[] = [{ label: args.orgName, href: routes.orgHome(org) }];

  if (rest[0] === "settings") {
    crumbs.push({ label: "Settings", href: routes.orgSettings(org) });
    if (rest[1] === "billing") {
      crumbs.push({ label: "Plan & billing", href: routes.billing(org) });
    }
    return crumbs;
  }

  if (rest[0] !== "c" || rest.length < 2) return crumbs;
  if (rest[1] === "new") {
    crumbs.push({ label: "New competition", href: routes.competitionNew(org) });
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
      label: compTail === "settings" ? "Settings" : "Schedule",
      href:
        compTail === "settings"
          ? routes.competitionSettings(org, comp)
          : routes.competitionSchedule(org, comp),
    });
    return crumbs;
  }

  if (compTail !== "d" || rest.length < 4) return crumbs;
  if (rest[3] === "new") {
    crumbs.push({ label: "New division", href: routes.divisionNew(org, comp) });
    return crumbs;
  }
  const div = rest[3] as string;
  const divLabel = args.names.divs[`${comp}/${div}`] ?? humanize(div);
  const divTail = rest[4];

  if (divTail === "f" && rest[5]) {
    // Fixture pages: the division crumb goes back to the fixtures tab.
    crumbs.push({ label: divLabel, href: routes.division(org, comp, div, "fixtures") });
    crumbs.push({ label: `Match ${rest[5]}`, href: routes.fixture(org, comp, div, Number(rest[5])) });
    return crumbs;
  }

  crumbs.push({ label: divLabel, href: routes.division(org, comp, div) });
  if (divTail === "schedule") {
    crumbs.push({ label: "Schedule", href: routes.divisionSchedule(org, comp, div) });
  } else if (divTail === "registrations") {
    crumbs.push({ label: "Registrations", href: routes.divisionRegistrations(org, comp, div) });
  }
  return crumbs;
}
