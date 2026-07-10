"use client";

import { useEffect, useState } from "react";

/** Lightweight centered modal with an overlay. */
export function Modal({
  title,
  children,
  onClose,
  footer,
  size = "md",
}: {
  title: string;
  children?: React.ReactNode;
  onClose: () => void;
  footer?: React.ReactNode;
  size?: "md" | "lg";
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const maxW = size === "lg" ? "sm:max-w-2xl" : "sm:max-w-md";

  return (
    <div className="modal-overlay" onClick={onClose}>
      {/* Bottom sheet under `sm`, centered modal above (v3/02 pattern 3). */}
      <div
        className={`flex max-h-[85vh] w-full ${maxW} flex-col rounded-t-2xl border border-purple-100 bg-white p-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))] shadow-2xl sm:rounded-2xl sm:pb-6`}
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="sheet-handle" aria-hidden />
        <div className="mb-3 flex shrink-0 items-center justify-between">
          <h3 className="text-lg font-semibold text-purple-900">{title}</h3>
          <button
            onClick={onClose}
            aria-label="Close"
            className="grid h-7 w-7 place-items-center rounded-full text-slate-400 hover:bg-purple-50 hover:text-purple-700"
          >
            ×
          </button>
        </div>
        {children && (
          <div className="min-h-0 flex-1 overflow-y-auto text-sm text-slate-600">
            {children}
          </div>
        )}
        {footer && (
          <div className="mt-5 flex shrink-0 justify-end gap-2">{footer}</div>
        )}
      </div>
    </div>
  );
}

/** Confirm dialog built on Modal. Pass `typeToConfirm` to require the user to type a word. */
export function ConfirmModal({
  title,
  message,
  confirmLabel = "Confirm",
  danger,
  typeToConfirm,
  onConfirm,
  onClose,
}: {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  typeToConfirm?: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState("");
  const canConfirm = !typeToConfirm || typed.trim().toUpperCase() === typeToConfirm.toUpperCase();

  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} className="btn btn-ghost">
            Cancel
          </button>
          <button
            disabled={!canConfirm}
            onClick={() => {
              onConfirm();
              onClose();
            }}
            className={`btn ${danger ? "btn-danger" : "btn-primary"} disabled:opacity-40`}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <p>{message}</p>
      {typeToConfirm && (
        <div className="mt-4">
          <p className="mb-1.5 text-xs text-slate-500">
            Type <span className="font-mono font-semibold text-red-600">{typeToConfirm}</span> to confirm
          </p>
          <input
            autoFocus
            type="text"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            className="input w-full"
            placeholder={typeToConfirm}
          />
        </div>
      )}
    </Modal>
  );
}
