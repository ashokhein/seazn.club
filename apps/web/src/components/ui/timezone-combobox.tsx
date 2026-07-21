"use client";

// Searchable timezone picker — replaces the 418-row <select> both timezone
// lanes used to render.
//
// Two things were wrong with the select. It was unscannable: finding a zone
// meant scrolling four hundred options, because a <select> cannot be typed
// into. And it grouped by IANA prefix, which is a filesystem convention rather
// than a geography — every Gulf state lives under `Asia/`, so Dubai sat between
// Tokyo and Kolkata. Rows here carry the country and the live local time, and
// group under human regions (lib/tz-data.ts), so Dubai files under Middle East.
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import { fmtGmtOffset, fmtTime } from "@/lib/format";
import {
  canonicalZone,
  groupByRegion,
  listZoneOptions,
  searchZones,
  zoneCity,
  type ZoneOption,
} from "@/lib/tz-options";
import { useLocale, useMsg } from "@/components/i18n/dict-provider";
import type { MessageKey } from "@/lib/messages";

export function TimezoneCombobox({
  value,
  onChange,
  ariaLabel,
  emptyLabel,
  allowEmpty = false,
  suggested = [],
  disabled = false,
}: {
  /** Canonical or legacy IANA id, or "" for no selection. */
  value: string;
  onChange: (next: string) => void;
  ariaLabel: string;
  /** Row shown for the "" choice, e.g. "Not set — schedules use UTC". */
  emptyLabel?: string;
  allowEmpty?: boolean;
  /** Zones to float above the regions when the search box is empty. */
  suggested?: string[];
  disabled?: boolean;
}) {
  const msg = useMsg();
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [now, setNow] = useState(() => new Date());
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const options = useMemo(() => listZoneOptions(locale), [locale]);
  const byZone = useMemo(() => new Map(options.map((o) => [o.zone, o])), [options]);

  // One clock for the whole list, and only while it is open — 418 rows each
  // holding their own interval would be 418 timers for one minute hand. The
  // reading is taken fresh in the open handler, so the effect only has to keep
  // it ticking.
  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, [open]);

  function openList() {
    setNow(new Date());
    setOpen(true);
  }

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  const hits = useMemo(() => searchZones(options, query), [options, query]);

  /**
   * One flat, ordered list of rows drives both the keyboard and the render, so
   * the highlighted row and the Enter target can never disagree.
   *
   * A suggested zone deliberately ALSO appears under its region — hiding Dubai
   * from Middle East because it happens to be suggested is more confusing than
   * listing it twice. That means the same ZoneOption occupies two rows, so rows
   * are identified by a per-position key rather than by zone: keying on zone
   * would give the two rows one DOM id between them and let the arrows skip the
   * regional copy.
   */
  const { rows, sections } = useMemo(() => {
    const flat: { key: string; option: ZoneOption }[] = [];
    if (query.trim()) {
      for (const option of hits) flat.push({ key: `r-${option.zone}`, option });
      return { rows: flat, sections: groupByRegion(hits) };
    }
    const seen = new Set<string>();
    for (const zone of suggested) {
      const option = byZone.get(canonicalZone(zone));
      if (option && !seen.has(option.zone)) {
        seen.add(option.zone);
        flat.push({ key: `s-${option.zone}`, option });
      }
    }
    const grouped = groupByRegion(hits);
    for (const [, list] of grouped) {
      for (const option of list) flat.push({ key: `r-${option.zone}`, option });
    }
    return { rows: flat, sections: grouped };
  }, [query, hits, suggested, byZone]);

  const suggestedRows = rows.filter((row) => row.key.startsWith("s-"));
  const indexOfKey = useMemo(
    () => new Map(rows.map((row, i) => [row.key, i])),
    [rows],
  );

  const selected = value ? byZone.get(canonicalZone(value)) : undefined;
  const selectedLabel = selected
    ? `${selected.city} · ${selected.country} · ${fmtTime(selected.zone, now)} ${fmtGmtOffset(selected.zone, now)}`
    : value
      ? // A stored zone the table does not know (hand-set, or a tzdata the
        // generated file predates). Show it rather than pretending it is unset.
        zoneCity(value)
      : (emptyLabel ?? msg("settings.tz.notSet"));

  function commit(zone: string) {
    onChange(zone);
    setOpen(false);
    setQuery("");
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      setOpen(false);
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const max = rows.length - 1;
      setActive((i) => (e.key === "ArrowDown" ? Math.min(max, i + 1) : Math.max(0, i - 1)));
      return;
    }
    if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      setActive(e.key === "Home" ? 0 : rows.length - 1);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const row = rows[active];
      if (row) commit(row.option.zone);
    }
  }

  // Keep the highlighted row in view as the arrows walk past the fold.
  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const activeId = rows[active] ? `${listId}-${rows[active].key}` : undefined;

  function Row({ rowKey, option }: { rowKey: string; option: ZoneOption }) {
    const isSelected = selected?.zone === option.zone;
    const index = indexOfKey.get(rowKey) ?? -1;
    return (
      <button
        type="button"
        role="option"
        id={`${listId}-${rowKey}`}
        data-index={index}
        aria-selected={isSelected}
        onMouseEnter={() => setActive(index)}
        onClick={() => commit(option.zone)}
        className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition ${
          index === active ? "bg-purple-100" : ""
        }`}
      >
        {/* Narrow screens stack the country under the city rather than dropping
            it: knowing Dubai is in the UAE is the reason this row exists, and
            a phone has the vertical room even when it lacks the horizontal. */}
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium text-slate-800">{option.city}</span>
          <span className="block truncate text-xs text-slate-500 sm:hidden">{option.country}</span>
        </span>
        <span className="hidden min-w-0 flex-1 truncate text-xs text-slate-500 sm:block">
          {option.country}
        </span>
        <span className="shrink-0 tabular-nums text-xs text-slate-500" suppressHydrationWarning>
          {fmtTime(option.zone, now)}
        </span>
        <span
          className="w-16 shrink-0 text-right tabular-nums text-xs text-slate-400"
          suppressHydrationWarning
        >
          {fmtGmtOffset(option.zone, now)}
        </span>
        {isSelected && <Check aria-hidden className="h-4 w-4 shrink-0 text-purple-700" />}
      </button>
    );
  }

  return (
    <div ref={rootRef} className="relative">
      {open ? (
        <div className="input flex w-full items-center gap-2 border-purple-500 ring-2 ring-purple-200">
          <Search aria-hidden className="h-4 w-4 shrink-0 text-purple-400" strokeWidth={2} />
          <input
            // Opening the picker IS the request to type, so focus follows the
            // click; the input only exists while the list is open.
            autoFocus
            role="combobox"
            aria-label={ariaLabel}
            aria-expanded
            aria-controls={listId}
            aria-activedescendant={activeId}
            aria-autocomplete="list"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              // Re-aim at the top hit as the query narrows, so Enter always
              // takes the best match rather than whatever sat at the old index.
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            placeholder={msg("settings.tz.search")}
            className="min-w-0 flex-1 bg-transparent outline-none"
          />
        </div>
      ) : (
        <button
          type="button"
          role="combobox"
          aria-label={ariaLabel}
          aria-expanded={false}
          aria-controls={listId}
          disabled={disabled}
          onClick={openList}
          className="input flex w-full items-center gap-2 text-left"
        >
          <span className="min-w-0 flex-1 truncate" suppressHydrationWarning>
            {selectedLabel}
          </span>
          <ChevronDown aria-hidden className="h-4 w-4 shrink-0 text-purple-400" />
        </button>
      )}

      {open && (
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label={ariaLabel}
          className="absolute z-30 mt-1 max-h-80 w-full overflow-y-auto rounded-xl border border-purple-100 bg-white shadow-lg"
        >
          {allowEmpty && !query.trim() && (
            <button
              type="button"
              role="option"
              aria-selected={!value}
              onClick={() => commit("")}
              className="w-full border-b border-purple-100 px-3 py-2 text-left text-sm text-slate-600 transition hover:bg-purple-50"
            >
              {emptyLabel ?? msg("settings.tz.notSet")}
            </button>
          )}

          {suggestedRows.length > 0 && (
            <Section label={msg("settings.tz.suggested")}>
              {suggestedRows.map((row) => (
                <Row key={row.key} rowKey={row.key} option={row.option} />
              ))}
            </Section>
          )}

          {sections.map(([region, list]) => (
            <Section key={region} label={msg(`settings.tz.region.${region}` as MessageKey)}>
              {list.map((option) => (
                <Row key={option.zone} rowKey={`r-${option.zone}`} option={option} />
              ))}
            </Section>
          ))}

          {rows.length === 0 && (
            <p className="px-3 py-6 text-center text-sm text-slate-500">
              {msg("settings.tz.noMatches", { query })}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div role="group" aria-label={label}>
      <p className="sticky top-0 z-10 border-y border-purple-100 bg-purple-50/90 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-purple-700 backdrop-blur">
        {label}
      </p>
      {children}
    </div>
  );
}
