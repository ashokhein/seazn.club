// Console route builders (PROMPT-30, v3/01 §2): slug hierarchy under /o —
// /o/[orgSlug]/c/[compSlug]/d/[divSlug]/f/[fixtureNo]. Every console
// <Link>/redirect() builds its href here, never by string concatenation
// (ESLint bans hardcoded console paths), so URL shapes change in one place.
// The URL — not the seazn_org cookie — is the source of truth for which org
// a page shows; multi-org tabs stay independent.

type Slug = string;

export const routes = {
  orgHome: (org: Slug) => `/o/${org}`,
  orgSettings: (org: Slug, tab?: string) =>
    tab ? `/o/${org}/settings?tab=${tab}` : `/o/${org}/settings`,
  billing: (org: Slug) => `/o/${org}/settings/billing`,
  competitionNew: (org: Slug) => `/o/${org}/c/new`,
  competition: (org: Slug, comp: Slug) => `/o/${org}/c/${comp}`,
  competitionSettings: (org: Slug, comp: Slug) => `/o/${org}/c/${comp}/settings`,
  competitionSchedule: (org: Slug, comp: Slug) => `/o/${org}/c/${comp}/schedule`,
  divisionNew: (org: Slug, comp: Slug) => `/o/${org}/c/${comp}/d/new`,
  division: (org: Slug, comp: Slug, div: Slug, tab?: string) =>
    tab ? `/o/${org}/c/${comp}/d/${div}?tab=${tab}` : `/o/${org}/c/${comp}/d/${div}`,
  divisionSchedule: (org: Slug, comp: Slug, div: Slug) =>
    `/o/${org}/c/${comp}/d/${div}/schedule`,
  divisionRegistrations: (org: Slug, comp: Slug, div: Slug) =>
    `/o/${org}/c/${comp}/d/${div}/registrations`,
  /** Fixtures are addressed by per-division ordinal — human-quotable ("match 14"). */
  fixture: (org: Slug, comp: Slug, div: Slug, no: number) =>
    `/o/${org}/c/${comp}/d/${div}/f/${no}`,
  /** Token/chromeless surfaces stay id-based — no slug chain in kiosk URLs. */
  slideshowCompetition: (competitionId: string) => `/slideshow/competitions/${competitionId}`,
  slideshowDivision: (divisionId: string) => `/slideshow/divisions/${divisionId}`,
  /** Public dashboard — slug-based already, marker-less scheme, unchanged. */
  shared: (orgSlug: Slug, compSlug?: Slug, divSlug?: Slug) =>
    ["/shared", orgSlug, compSlug, divSlug].filter(Boolean).join("/"),
} as const;
