"use client";

// Promise-based confirmation (v3/03 §3) — the ONE replacement for
// window.confirm. `const ok = await confirm({...})` from any client
// component; a single provider in the root layout renders the dialog:
// centered modal ≥sm, bottom sheet with a drag handle under sm (v3/02
// pattern 3). tone:"danger" requires an explicit click (Enter never
// submits); `typedName` keeps the button disabled until the user types the
// resource name exactly. Focus-trapped, Esc cancels, focus restored.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { readLocaleCookie, clientCommon } from "@/lib/client-dict";
import { isConfirmArmed } from "@/lib/typed-confirm";

export interface ConfirmOptions {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  tone?: "default" | "danger";
  /** Require typing this exact string before the confirm button arms. */
  typedName?: string;
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

export function useConfirm(): ConfirmFn {
  const fn = useContext(ConfirmContext);
  if (!fn) throw new Error("useConfirm needs <ConfirmProvider> in the tree");
  return fn;
}

interface Pending {
  opts: ConfirmOptions;
  resolve: (ok: boolean) => void;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);

  const confirm = useCallback<ConfirmFn>((opts) => {
    return new Promise<boolean>((resolve) => {
      // One dialog at a time: a second request cancels the first.
      setPending((prev) => {
        prev?.resolve(false);
        return { opts, resolve };
      });
    });
  }, []);

  const settle = useCallback(
    (ok: boolean) => {
      setPending((prev) => {
        prev?.resolve(ok);
        return null;
      });
    },
    [],
  );

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending && <ConfirmSurface key={pending.opts.title} opts={pending.opts} settle={settle} />}
    </ConfirmContext.Provider>
  );
}

/** Split the typed-challenge copy around its {name} slot so the name can
 *  render in mono without the message layer knowing about JSX. */
function typedInstruction(): { before: string; after: string } {
  // Renders at the root ConfirmProvider (outside any DictProvider), so it reads
  // the locale from the cookie via the small `common` client bundle.
  const [before = "", after = ""] = clientCommon(
    readLocaleCookie(),
    "dialog.typedInstruction",
  ).split("{name}");
  return { before, after };
}

function ConfirmSurface({
  opts,
  settle,
}: {
  opts: ConfirmOptions;
  settle: (ok: boolean) => void;
}) {
  const { title, body, confirmLabel, tone = "default", typedName } = opts;
  const [typed, setTyped] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const armed = isConfirmArmed(typedName, typed);

  useEffect(() => {
    restoreRef.current = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    // Focus the first focusable control (typed input, else Cancel).
    const focusables = () =>
      Array.from(
        dialog?.querySelectorAll<HTMLElement>(
          'button, input, [href], [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
    focusables()[0]?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        settle(false);
      }
      if (e.key === "Tab") {
        // Minimal focus trap: wrap at the edges.
        const items = focusables();
        if (items.length === 0) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      restoreRef.current?.focus?.();
    };
  }, [settle]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-purple-950/30 backdrop-blur-sm sm:items-center sm:p-4"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) settle(false);
      }}
    >
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        className="flex max-h-[85vh] w-full flex-col overflow-y-auto rounded-t-2xl border border-purple-100 bg-white p-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))] shadow-2xl sm:max-w-md sm:rounded-2xl sm:pb-6"
      >
        {/* Sheet drag handle — visual affordance only, phones only. */}
        <div aria-hidden className="mx-auto mb-4 h-1 w-10 rounded-full bg-slate-200 sm:hidden" />
        <h2 className="text-base font-semibold text-slate-900">{title}</h2>
        <div className="mt-2 space-y-2 text-sm text-slate-600">{body}</div>
        {typedName !== undefined && (
          <label className="mt-4 block">
            <span className="label">
              {typedInstruction().before}
              <span className="font-mono font-semibold">{typedName}</span>
              {typedInstruction().after}
            </span>
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              className="input w-full"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
        )}
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button type="button" className="btn btn-ghost" onClick={() => settle(false)}>
            {clientCommon(readLocaleCookie(), "dialog.cancel")}
          </button>
          <button
            type={tone === "danger" ? "button" : "submit"}
            className={`btn ${tone === "danger" ? "btn-danger" : "btn-primary"}`}
            disabled={!armed}
            onClick={() => settle(true)}
            onKeyDown={(e) => {
              // Danger never submits on Enter — explicit click/Space only.
              if (tone === "danger" && e.key === "Enter") e.preventDefault();
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
