// Meta-description builders for the public /shared tree. A page must always
// return a non-empty description: this Next build does not fall back to the
// root layout's description, so `undefined` here means NO meta description,
// og:description or twitter:description at all (caught by a link-preview
// inspector on stg).
export function competitionMetaDescription(
  competitionName: string,
  orgName: string,
  competitionDescription?: string | null,
): string {
  const own = competitionDescription?.trim();
  if (own) return own.slice(0, 160);
  return `Live scores, standings and brackets for ${competitionName} — hosted by ${orgName} on Seazn Club.`;
}

export function playerMetaDescription(
  playerName: string,
  competitionName: string,
): string {
  return `${playerName}'s player card at ${competitionName} — appearances, results and stats on Seazn Club.`;
}
