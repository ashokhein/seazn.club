// Sticky bottom action bar (v3/02 pattern 2): the page's primary action
// docks above the thumb on phones (safe-area aware) and renders inline on
// desktop. Wrap the existing button(s); add nothing else — one primary
// action per page.
import type { ReactNode } from "react";

export function ActionBar({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <>
      <div className={`bottom-bar ${className}`}>
        <div className="flex items-center justify-end gap-2 [&>*]:flex-1 sm:[&>*]:flex-none">
          {children}
        </div>
      </div>
      <div className="bottom-bar-spacer" aria-hidden />
    </>
  );
}
