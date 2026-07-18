// SPEC-1 public "Suspensions" strip — active bans under the standings table,
// one dense zebra line each (name via public_person_name consent, matches left
// to serve). Muted courtside --ps-* palette, no card-glyph colour on the public
// tier (design direction). Renders nothing when there are no active bans.

export function SuspensionsStrip({
  suspensions,
}: {
  suspensions: { name: string; remaining: number }[];
}) {
  if (suspensions.length === 0) return null;
  return (
    <section className="mt-8" data-testid="public-suspensions">
      <h3 className="mb-3 font-display text-lg font-semibold text-ink">Suspensions</h3>
      <ul className="overflow-hidden rounded-xl border border-zinc-200/80">
        {suspensions.map((s, i) => (
          <li
            key={i}
            className="flex items-center justify-between gap-3 px-4 py-2 text-sm odd:bg-surface even:bg-zinc-50/60"
          >
            <span className="min-w-0 truncate text-ink">{s.name}</span>
            <span className="shrink-0 text-xs text-ink-muted">{s.remaining} to serve</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
