"use client";

import { useEffect } from "react";

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

  const maxW = size === "lg" ? "max-w-2xl" : "max-w-md";

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className={`flex max-h-[85vh] w-full ${maxW} flex-col rounded-2xl border border-purple-100 bg-white p-6 shadow-2xl`}
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
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

/** Confirm dialog built on Modal. */
export function ConfirmModal({
  title,
  message,
  confirmLabel = "Confirm",
  danger,
  onConfirm,
  onClose,
}: {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
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
            onClick={() => {
              onConfirm();
              onClose();
            }}
            className={`btn ${danger ? "btn-danger" : "btn-primary"}`}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      {message}
    </Modal>
  );
}
