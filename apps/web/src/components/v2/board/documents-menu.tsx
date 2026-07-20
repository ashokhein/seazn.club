"use client";

import { useEffect, useRef, useState } from "react";
// Documents menu (v12 task 15): one control on the schedule board that
// surfaces every matchday document instead of the single "Print schedule"
// timetable link it replaces. A native <details>/<summary> disclosure —
// keyboard-focusable and togglable out of the box, and (unlike a JS-driven
// popover) its content stays in the static DOM even while closed, which is
// what makes it trivially testable with renderToStaticMarkup (see the
// sibling stages-panel-*.test.tsx files for the same pattern). Each row is a
// raw file-download link (not a client <Link>), matching how every other
// export button in this codebase links straight to the /api/v1 route.
import { useMsg } from "@/components/i18n/dict-provider";

/** Should a pointerdown on `target` dismiss the menu? Extracted so the rule is
 *  testable: this workspace runs vitest with environment "node" and has no
 *  jsdom, so the effect that consumes it cannot be exercised directly. */
export function dismissesMenu(
  root: { open: boolean; contains: (n: Node) => boolean } | null,
  target: Node,
): boolean {
  if (!root?.open) return false;
  return !root.contains(target);
}

/** One place builds the URL, so the busy-state comparison can never drift
 *  from the URL the download actually requests. */
function docUrl(row: DocRow, format: "pdf" | "xlsx"): string {
  return `${row.base}?format=${format}${row.params ? `&${row.params}` : ""}`;
}

interface DocRow {
  label: string;
  base: string;
  /** Admit tickets only ship as PDF — no spreadsheet edition. */
  xlsx: boolean;
  /** Participants is the mirror case: a spreadsheet with no print edition. */
  pdf?: boolean;
  /** Extra query the endpoint needs — standings wants landscape paper. */
  params?: string;
}

export function DocumentsMenu({
  divisionId,
  competitionId,
}: {
  divisionId: string;
  competitionId: string;
}) {
  const msg = useMsg();
  // F3: downloads go through fetch so an error becomes an inline message —
  // never a raw JSON envelope in the browser tab.
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // A bare <details> only ever toggles from its own <summary>, so the menu sat
  // open over the fixtures list until you went back and clicked the trigger
  // again. Close it the way every other popover here does — pointerdown
  // outside, or Escape. The listeners are only attached while it is open, and
  // the markup stays static either way so renderToStaticMarkup tests still see
  // every row.
  const rootRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = () => {
      if (rootRef.current) rootRef.current.open = false;
    };
    const onDown = (e: PointerEvent) => {
      if (dismissesMenu(rootRef.current, e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  async function download(row: DocRow, format: "pdf" | "xlsx") {
    const url = docUrl(row, format);
    setBusy(url);
    setErrors((e) => ({ ...e, [row.base]: undefined as never }));
    try {
      const res = await fetch(url);
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        setErrors((e) => ({
          ...e,
          [row.base]: body?.error?.message ?? msg("documents.error"),
        }));
        return;
      }
      const blob = await res.blob();
      const href = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = href;
      a.download = `${row.base.split("/").pop()}.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(href);
    } catch {
      setErrors((e) => ({ ...e, [row.base]: msg("documents.error") }));
    } finally {
      setBusy(null);
    }
  }

  const rows: DocRow[] = [
    {
      label: msg("documents.orderOfPlay"),
      base: `/api/v1/divisions/${divisionId}/exports/timetable`,
      xlsx: true,
    },
    {
      label: msg("documents.matchSheets"),
      base: `/api/v1/divisions/${divisionId}/exports/scoresheet`,
      xlsx: true,
    },
    {
      label: msg("documents.rota"),
      base: `/api/v1/divisions/${divisionId}/exports/officials_rota`,
      xlsx: true,
    },
    {
      label: msg("documents.tickets"),
      base: `/api/v1/competitions/${competitionId}/exports/tickets`,
      xlsx: false,
    },
    {
      // PROMPT-62 §4 — landscape results poster (422s until a knockout exists).
      label: msg("documents.bracket"),
      base: `/api/v1/divisions/${divisionId}/exports/bracket`,
      xlsx: false,
    },
    // Moved off the schedule page header, which carried its own row of five
    // export buttons. Two of those (timetable, scoresheet) already lived here;
    // these three did not, so they come across rather than disappear.
    {
      label: msg("documents.rosters"),
      base: `/api/v1/divisions/${divisionId}/exports/roster`,
      xlsx: false,
    },
    {
      label: msg("documents.standings"),
      base: `/api/v1/divisions/${divisionId}/exports/standings`,
      xlsx: false,
      params: "landscape=true",
    },
    {
      label: msg("documents.participants"),
      base: `/api/v1/divisions/${divisionId}/exports/participants`,
      xlsx: true,
      pdf: false,
    },
  ];

  return (
    <details ref={rootRef} className="relative">
      <summary
        className="btn btn-ghost cursor-pointer text-xs [&::-webkit-details-marker]:hidden"
        data-testid="documents-menu-trigger"
      >
        {msg("documents.title")}
      </summary>
      <div
        role="menu"
        aria-label={msg("documents.title")}
        className="absolute right-0 top-9 z-20 w-64 rounded-xl border border-purple-100 bg-white py-1 shadow-lg"
      >
        {rows.map((row) => (
          <div key={row.label} className="px-3 py-2 text-sm text-slate-700">
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate">{row.label}</span>
              <span className="flex shrink-0 items-center gap-2 text-xs font-medium">
                {row.pdf !== false && (
                  <button
                    type="button"
                    role="menuitem"
                    disabled={busy === docUrl(row, "pdf")}
                    onClick={() => void download(row, "pdf")}
                    className="text-purple-700 hover:underline focus-visible:underline disabled:text-slate-300"
                  >
                    {msg("documents.pdf")}
                  </button>
                )}
                {row.xlsx && (
                  <button
                    type="button"
                    role="menuitem"
                    disabled={busy === docUrl(row, "xlsx")}
                    onClick={() => void download(row, "xlsx")}
                    className="text-purple-700 hover:underline focus-visible:underline disabled:text-slate-300"
                  >
                    {msg("documents.xlsx")}
                  </button>
                )}
              </span>
            </div>
            {errors[row.base] !== undefined && (
              <p role="alert" className="mt-1 text-xs text-amber-700">
                {errors[row.base]}
              </p>
            )}
          </div>
        ))}
      </div>
    </details>
  );
}
