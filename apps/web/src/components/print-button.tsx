"use client";

export function PrintButton() {
  return (
    <button
      onClick={() => window.print()}
      className="btn btn-primary print:hidden"
    >
      🖨 Print this page
    </button>
  );
}
