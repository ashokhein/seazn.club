"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { parseIntCell } from "@/lib/parse-int-cell";

// Focus-visible ring shared by every interactive cell control. px-2 py-1.5
// padding gives each control a comfortable hit area in the dense grid (roughly
// 28-32px tall — below the 44px mobile ideal, but this table is admin-only).
const RING =
  "rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-400 focus-visible:ring-offset-1 focus-visible:ring-offset-slate-900";

export function EntCellEditor(props: {
  planKey: string;
  featureKey: string;
  type: "bool" | "int";
  // hasInt: this feature carries an int cap on some plan, so even a "bool"
  // feature renders the int editor alongside the toggle (dual-value cell).
  hasInt: boolean;
  // present: a real plan_entitlements row exists. Absent = DENY (getLimit → 0),
  // rendered "—", NOT unlimited ∞. Clicking an absent cell CREATES the row.
  present: boolean;
  boolValue: boolean | null;
  intValue: number | null;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [val, setVal] = useState<string>(props.intValue === null ? "" : String(props.intValue));

  // Every PATCH sends BOTH columns. The route upsert sets bool_value AND
  // int_value from the body (`${body.int_value ?? null}`), so omitting either
  // would null the other — the latent data-loss the dual-value cells expose.
  async function save(patch: { bool_value: boolean | null; int_value: number | null }) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/entitlements", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ plan_key: props.planKey, feature_key: props.featureKey, ...patch }),
      });
      if (res.ok) {
        setEditing(false);
        router.refresh();
      } else {
        setError("Save failed");
      }
    } catch {
      setError("Save failed");
    } finally {
      setBusy(false);
    }
  }

  function commitInt() {
    const parsed = parseIntCell(val);
    if (!parsed.ok) {
      // Invalid input: do NOT call the API, stay editing, show inline error.
      setError("Whole number ≥ 0, or blank for ∞");
      return;
    }
    // Preserve the co-stored bool_value so the upsert doesn't null it.
    void save({ bool_value: props.boolValue, int_value: parsed.value });
  }

  function openEditor() {
    setVal(props.present && props.intValue !== null ? String(props.intValue) : "");
    setError(null);
    setEditing(true);
  }

  const showBool = props.type === "bool";
  const showInt = props.type === "int" || props.hasInt;

  const boolToggle = (
    <button
      type="button"
      disabled={busy}
      className={`px-2 py-1.5 text-slate-300 hover:text-white disabled:opacity-50 ${RING}`}
      title={props.present ? "Toggle" : "No row — resolves as DENY. Click to create."}
      aria-label={`${props.present ? "Toggle" : "Create"} ${props.featureKey} for ${props.planKey}`}
      // Toggle preserves the co-stored int_value (send both values).
      onClick={() => void save({ bool_value: !(props.boolValue === true), int_value: props.intValue })}
    >
      {props.present && props.boolValue === true ? "✓" : "—"}
    </button>
  );

  const intControl = editing ? (
    <span className="inline-flex items-center gap-1">
      <input
        autoFocus
        inputMode="numeric"
        value={val}
        onChange={(e) => {
          setVal(e.target.value);
          if (error) setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commitInt();
          } else if (e.key === "Escape") {
            e.preventDefault();
            setEditing(false);
            setError(null);
          }
        }}
        placeholder="∞"
        aria-invalid={error ? true : undefined}
        aria-label={`${props.featureKey} limit for ${props.planKey} (blank = unlimited)`}
        className={`w-14 rounded border bg-slate-900 px-1 py-1.5 text-xs text-white focus-visible:outline-none focus-visible:ring-2 ${
          error
            ? "border-red-500 ring-2 ring-red-500"
            : "border-slate-600 focus-visible:ring-lime-400"
        }`}
      />
      <button
        type="button"
        disabled={busy}
        className={`px-2 py-1.5 text-xs text-lime-400 disabled:opacity-50 ${RING}`}
        onClick={commitInt}
      >
        save
      </button>
      <button
        type="button"
        className={`px-2 py-1.5 text-xs text-slate-500 ${RING}`}
        onClick={() => {
          setEditing(false);
          setError(null);
        }}
      >
        esc
      </button>
    </span>
  ) : (
    <button
      type="button"
      className={`px-2 py-1.5 text-slate-300 hover:text-white ${RING}`}
      title={props.present ? "Edit limit" : "No row — resolves as DENY. Click to create."}
      aria-label={`Edit ${props.featureKey} limit for ${props.planKey}`}
      onClick={openEditor}
    >
      {props.present ? (props.intValue === null ? "∞" : props.intValue) : "—"}
    </button>
  );

  return (
    <span className="inline-flex items-center gap-1">
      {showBool && boolToggle}
      {showInt && intControl}
      {error && (
        <span role="alert" className="text-[10px] leading-tight text-red-400">
          {error}
        </span>
      )}
    </span>
  );
}
