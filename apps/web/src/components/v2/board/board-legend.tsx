"use client";

// Legend-as-filter (v3/04 §2): the division colour legend doubles as the
// filter. Tap chips to isolate any subset; state lives in the URL (?d=slug,
// slug) so a filtered view is shareable. Empty selection = everyone.
import { divisionAccent, divisionInk, divisionShortCode, divisionTint } from "@/lib/division-hue";
import { Tip } from "@/components/ui/tip";
import type { BoardDivision } from "./types";
import { useMsg } from "@/components/i18n/dict-provider";

export function BoardLegend({
  divisions,
  selected,
  onToggle,
  onClear,
}: {
  divisions: BoardDivision[];
  /** Selected division slugs; empty set = no filter (all divisions). */
  selected: ReadonlySet<string>;
  onToggle: (slug: string) => void;
  onClear: () => void;
}) {
  const msg = useMsg();
  if (divisions.length <= 1) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={msg("board.filterAria")}>
      {divisions.map((d) => {
        const active = selected.size === 0 || selected.has(d.slug);
        return (
          <button
            key={d.id}
            type="button"
            onClick={() => onToggle(d.slug)}
            aria-pressed={selected.has(d.slug)}
            title={d.name}
            className={`inline-flex min-h-8 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition ${
              active
                ? "border-transparent"
                : "border-slate-200 bg-white text-slate-500 opacity-60"
            }`}
            style={
              active
                ? { backgroundColor: divisionTint(d.id), color: divisionInk(d.id) }
                : undefined
            }
          >
            <span
              aria-hidden
              className="h-2.5 w-2.5 rounded-sm"
              style={{ backgroundColor: divisionAccent(d.id) }}
            />
            <span className="sm:hidden">{divisionShortCode(d.name)}</span>
            <span className="hidden sm:inline">{d.name}</span>
          </button>
        );
      })}
      {selected.size > 0 && (
        <button
          type="button"
          onClick={onClear}
          className="min-h-8 rounded-full px-2 text-xs font-medium text-purple-700 hover:underline"
        >
          {msg("board.showAll")}
        </button>
      )}
      <Tip id="board.filter" />
    </div>
  );
}
