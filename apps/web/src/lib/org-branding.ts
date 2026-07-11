// Org branding blob helpers (v3/10 #5). One jsonb column carries colors AND
// sponsors — every write must merge, never replace, or setting a brand color
// silently deletes the sponsor strip (and vice versa). Pure + isomorphic so
// the merge is unit-tested.

export interface Sponsor {
  name: string;
  url?: string | null;
  /** Storage path or absolute URL of the logo. */
  logo?: string | null;
}

export interface OrgBranding {
  colors?: { primary?: string };
  sponsors?: Sponsor[];
  [k: string]: unknown;
}

function asBranding(value: unknown): OrgBranding {
  return typeof value === "object" && value !== null ? { ...(value as OrgBranding) } : {};
}

/** Set/clear the brand color, keeping everything else in the blob. */
export function mergeBrandColor(existing: unknown, primary: string | null): OrgBranding {
  const next = asBranding(existing);
  if (primary === null) delete next.colors;
  else next.colors = { primary: primary.toLowerCase() };
  return next;
}

/** Replace the sponsor list, keeping everything else in the blob. */
export function mergeSponsors(existing: unknown, sponsors: Sponsor[]): OrgBranding {
  const next = asBranding(existing);
  if (sponsors.length === 0) delete next.sponsors;
  else {
    next.sponsors = sponsors.map((s) => ({
      name: s.name,
      ...(s.url ? { url: s.url } : {}),
      ...(s.logo ? { logo: s.logo } : {}),
    }));
  }
  return next;
}

/** Read sponsors out of a branding blob (org or competition). */
export function brandingSponsors(branding: unknown): Sponsor[] {
  const list = asBranding(branding).sponsors;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (s): s is Sponsor => typeof s === "object" && s !== null && typeof s.name === "string",
  );
}
