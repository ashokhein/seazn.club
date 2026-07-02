/** Small round logo/flag/photo for a player or team, with initials fallback. */
export function Avatar({
  name,
  src,
  size = 24,
  className = "",
}: {
  name: string | null;
  src?: string | null;
  size?: number;
  className?: string;
}) {
  const dim = { width: size, height: size };
  if (src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt=""
        style={dim}
        className={`shrink-0 rounded-full object-cover ring-1 ring-purple-200 ${className}`}
      />
    );
  }
  const initials = (name ?? "?")
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return (
    <span
      style={{ ...dim, fontSize: Math.max(10, Math.round(size * 0.4)) }}
      className={`grid shrink-0 place-items-center rounded-full bg-purple-100 font-semibold text-purple-700 ${className}`}
    >
      {initials || "?"}
    </span>
  );
}
