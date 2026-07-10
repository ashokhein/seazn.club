// Console route builder (v3/01 §6). Every console <Link>/redirect builds its
// href here, never by string concatenation — so when PROMPT-30 moves the
// console to slug-based /o/[org]/c/[comp]/d/[div] URLs, only this file's
// internals change. Until then the builders emit today's id-based routes and
// deliberately ignore slug arguments some callers already pass.

type Id = string;

export const routes = {
  dashboard: () => "/dashboard",
  competitionNew: () => "/competitions/new",
  competition: (competitionId: Id) => `/competitions/${competitionId}`,
  competitionSettings: (competitionId: Id) => `/competitions/${competitionId}/settings`,
  competitionSchedule: (competitionId: Id) => `/competitions/${competitionId}/schedule`,
  divisionNew: (competitionId: Id) => `/competitions/${competitionId}/divisions/new`,
  division: (divisionId: Id, tab?: string) =>
    tab ? `/divisions/${divisionId}?tab=${tab}` : `/divisions/${divisionId}`,
  divisionSchedule: (divisionId: Id) => `/divisions/${divisionId}/schedule`,
  divisionRegistrations: (divisionId: Id) => `/divisions/${divisionId}/registrations`,
  settings: (tab?: string) => (tab ? `/settings?tab=${tab}` : "/settings"),
  billing: () => "/settings/billing",
  slideshowCompetition: (competitionId: Id) => `/slideshow/competitions/${competitionId}`,
  slideshowDivision: (divisionId: Id) => `/slideshow/divisions/${divisionId}`,
  /** Public dashboard path — already slug-based, unchanged by PROMPT-30. */
  shared: (orgSlug: string, compSlug?: string, divSlug?: string) =>
    ["/shared", orgSlug, compSlug, divSlug].filter(Boolean).join("/"),
} as const;
