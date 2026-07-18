"use client";

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

interface DocRow {
  label: string;
  base: string;
  /** Admit tickets only ship as PDF — no spreadsheet edition. */
  xlsx: boolean;
}

export function DocumentsMenu({
  divisionId,
  competitionId,
}: {
  divisionId: string;
  competitionId: string;
}) {
  const msg = useMsg();
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
  ];

  return (
    <details className="relative">
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
          <div
            key={row.label}
            className="flex items-center justify-between gap-2 px-3 py-2 text-sm text-slate-700"
          >
            <span className="min-w-0 truncate">{row.label}</span>
            <span className="flex shrink-0 items-center gap-2 text-xs font-medium">
              <a
                role="menuitem"
                href={`${row.base}?format=pdf`}
                className="text-purple-700 hover:underline focus-visible:underline"
              >
                {msg("documents.pdf")}
              </a>
              {row.xlsx && (
                <a
                  role="menuitem"
                  href={`${row.base}?format=xlsx`}
                  className="text-purple-700 hover:underline focus-visible:underline"
                >
                  {msg("documents.xlsx")}
                </a>
              )}
            </span>
          </div>
        ))}
      </div>
    </details>
  );
}
