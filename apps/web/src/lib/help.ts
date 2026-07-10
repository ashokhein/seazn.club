// Help-centre link resolver. /help ships in PROMPT-35; until its article
// registry exists every slug resolves to null and "Learn more" links simply
// don't render (v3/03 §4 — no dead links). PROMPT-35 replaces the body of
// this function with a lookup against its article registry.

export function helpUrl(slug: string | undefined): string | null {
  void slug;
  return null;
}
