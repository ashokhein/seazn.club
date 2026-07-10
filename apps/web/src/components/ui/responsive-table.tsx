// ResponsiveTable (v3/02 pattern 1): every data table's stacked-card
// rendering under `sm`, implemented once. Desktop keeps the semantic
// `.table`; phones get a card list — primary line, 2–3 key fields, actions
// in the caller's overflow. Server-safe (no hooks) — interactive cells come
// in through `render`/`renderCard` as client children.
import type { ReactNode } from "react";

export interface ResponsiveColumn<T> {
  key: string;
  header: ReactNode;
  /** Cell renderer; defaults align left, pass className for numeric right-align etc. */
  render: (row: T) => ReactNode;
  className?: string;
  headerClassName?: string;
}

export function ResponsiveTable<T>({
  columns,
  rows,
  keyOf,
  renderCard,
  empty = null,
  "aria-label": ariaLabel,
}: {
  columns: ResponsiveColumn<T>[];
  rows: T[];
  keyOf: (row: T) => string;
  /** The `sm`-down card for one row: name line + key fields + `⋯` actions. */
  renderCard: (row: T) => ReactNode;
  empty?: ReactNode;
  "aria-label"?: string;
}) {
  if (rows.length === 0) return <>{empty}</>;

  return (
    <>
      {/* Desktop: real table semantics. */}
      <div className="scroll-x scroll-x-fade hidden sm:block">
        <table className="table" aria-label={ariaLabel}>
          <thead>
            <tr>
              {columns.map((col) => (
                <th key={col.key} className={col.headerClassName}>
                  {col.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={keyOf(row)}>
                {columns.map((col) => (
                  <td key={col.key} className={col.className}>
                    {col.render(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* Phones: stacked cards, thumb-sized targets. */}
      <ul className="space-y-2 sm:hidden" aria-label={ariaLabel}>
        {rows.map((row) => (
          <li key={keyOf(row)} className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
            {renderCard(row)}
          </li>
        ))}
      </ul>
    </>
  );
}
