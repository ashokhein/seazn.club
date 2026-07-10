// Youth privacy (v3/11 gap 8): per-division public name rendering. The DB
// stores full names (organiser-side lists and exports are untouched); public
// surfaces — dashboards, /r/[ref], slideshow, OG images — mask through here.

export type NameDisplay = "full" | "first_initial";

/** NULL column resolves at read time: youth defaults to first_initial. */
export function resolveNameDisplay(
  setting: string | null | undefined,
  youth: boolean,
): NameDisplay {
  if (setting === "full" || setting === "first_initial") return setting;
  return youth ? "first_initial" : "full";
}

function maskOne(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts[0]} ${parts[parts.length - 1]![0]}.`;
}

/**
 * "Arun Kumar" → "Arun K." (first_initial). Pair display names joined with
 * "&" or "/" mask each side. Full mode is the identity.
 */
export function maskDisplayName(name: string, mode: NameDisplay): string {
  if (mode === "full") return name;
  return name
    .split(/\s*([&/])\s*/)
    .map((part) => (part === "&" || part === "/" ? ` ${part} ` : maskOne(part)))
    .join("")
    .trim();
}
