// EntityLogo (v3/03 §5): THE badge renderer. One fallback chain everywhere —
// team logo → club logo → org monogram → initials — so a surface never
// decides badge logic itself. Server-safe (no hooks). team_display_v already
// coalesces team→club, so most callers pass one resolved `src`.
//
// Placement rule (the §5 matrix): one logo per level per surface. This
// component renders the ENTITY level; org chrome (nav, mastheads) keeps its
// own org logo and never passes it here as `src`.

const SIZE_CLASS: Record<20 | 24 | 40, string> = {
  20: "h-5 w-5 text-[9px]",
  24: "h-6 w-6 text-[10px]",
  40: "h-10 w-10 text-sm",
};

export function EntityLogo({
  src,
  name,
  orgName,
  size = 20,
  className = "",
}: {
  /** Resolved badge URL (team, or club via team_display_v). */
  src?: string | null;
  /** Entity display name — initials fallback + alt text. */
  name: string;
  /** Org name: enables the monogram step of the chain (violet letter mark). */
  orgName?: string | null;
  size?: 20 | 24 | 40;
  className?: string;
}) {
  const base = `inline-flex shrink-0 items-center justify-center overflow-hidden rounded-md align-middle ${SIZE_CLASS[size]} ${className}`;

  if (src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={src} alt="" aria-hidden className={`${base} bg-white object-contain`} />
    );
  }
  if (orgName) {
    return (
      <span
        aria-hidden
        className={`${base} bg-gradient-to-br from-purple-500 to-fuchsia-500 font-bold text-white`}
      >
        {orgName.charAt(0).toUpperCase()}
      </span>
    );
  }
  return (
    <span aria-hidden className={`${base} bg-slate-100 font-semibold text-slate-500`}>
      {initials(name)}
    </span>
  );
}

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[words.length - 1]![0]!).toUpperCase();
}
