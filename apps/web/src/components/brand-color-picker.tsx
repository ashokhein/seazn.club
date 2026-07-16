"use client";

// Named swatch picker for the curated brand palette (lib/brand-palette).
// Pure controlled UI — parents wire persistence. `value` is the stored hex,
// null = the leading "default" chip (platform violet for orgs, "inherit"
// for competitions).
import { BRAND_PALETTE } from "@/lib/brand-palette";
import { useMsg } from "@/components/i18n/dict-provider";
import { swatchLabel } from "@/lib/scoring-vocab";

/** Platform violet — used only to paint the default chip's disc. */
const DEFAULT_HEX = "#7c3aed";

export function BrandColorPicker({
  value,
  onSelect,
  disabled = false,
  defaultLabel = "Violet",
  defaultHex = DEFAULT_HEX,
}: {
  value: string | null;
  onSelect: (hex: string | null) => void;
  disabled?: boolean;
  /** Name on the null chip, e.g. "Violet" (org) or "Same as organisation". */
  defaultLabel?: string;
  /** Disc color for the null chip, e.g. the inherited org color. */
  defaultHex?: string;
}) {
  const msg = useMsg();
  const current = value?.toLowerCase() ?? null;
  const chips: { name: string; hex: string | null; disc: string }[] = [
    { name: defaultLabel, hex: null, disc: defaultHex },
    ...BRAND_PALETTE.map((s) => ({ name: s.name, hex: s.hex as string | null, disc: s.hex })),
  ];
  return (
    <div className="flex flex-wrap gap-2">
      {chips.map((s) => {
        const selected = s.hex === current;
        return (
          <button
            key={s.name}
            type="button"
            disabled={disabled}
            aria-pressed={selected}
            onClick={() => onSelect(s.hex)}
            className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${
              selected
                ? "border-purple-400 bg-purple-50 text-purple-700"
                : "border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50"
            }`}
          >
            <span
              aria-hidden
              className="h-4 w-4 shrink-0 rounded-full ring-1 ring-inset ring-black/10"
              style={{ background: s.disc }}
            />
            {swatchLabel(s.hex, msg) ?? s.name}
          </button>
        );
      })}
    </div>
  );
}
