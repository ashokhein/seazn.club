"use client";

// Modal confirmation (v3/03 §3 — replaces window.confirm for destructive
// actions). `typedName` escalates to type-to-confirm: the button stays
// disabled until the user types the resource name exactly (v3/09 §4 division
// delete). Body copy must state what is destroyed vs kept.
import { useEffect, useRef, useState, type ReactNode } from "react";

interface Props {
  open: boolean;
  title: string;
  children: ReactNode; // body copy: exactly what happens, destroyed vs kept
  confirmLabel: string;
  /** Require typing this exact string to enable the confirm button. */
  typedName?: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  typedName,
  busy = false,
  onConfirm,
  onCancel,
}: Props) {
  const [typed, setTyped] = useState("");
  const [lastOpen, setLastOpen] = useState(open);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset the typed challenge on every open (adjust-state-during-render — no
  // effect, no cascading re-render).
  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) setTyped("");
  }

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    inputRef.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;
  const armed = typedName === undefined || typed === typedName;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="card w-full max-w-md space-y-4 p-6 shadow-xl">
        <h2 className="text-base font-semibold text-slate-900">{title}</h2>
        <div className="space-y-2 text-sm text-slate-600">{children}</div>
        {typedName !== undefined && (
          <label className="block">
            <span className="label">
              Type <span className="font-mono font-semibold">{typedName}</span> to confirm
            </span>
            <input
              ref={inputRef}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              className="input w-full"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-danger"
            onClick={onConfirm}
            disabled={busy || !armed}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
