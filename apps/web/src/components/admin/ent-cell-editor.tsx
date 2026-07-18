"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

// Focus-visible ring shared by every interactive cell control. ≥44px touch
// targets via px-2 py-1.5 padding so the dense grid stays tappable on mobile.
const RING =
  "rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-400 focus-visible:ring-offset-1 focus-visible:ring-offset-slate-900";

export function EntCellEditor(props: {
  planKey: string;
  featureKey: string;
  type: "bool" | "int";
  boolValue: boolean | null;
  intValue: number | null;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [val, setVal] = useState<string>(props.intValue === null ? "" : String(props.intValue));

  async function save(patch: { bool_value?: boolean | null; int_value?: number | null }) {
    setBusy(true);
    try {
      const res = await fetch("/api/admin/entitlements", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ plan_key: props.planKey, feature_key: props.featureKey, ...patch }),
      });
      if (res.ok) {
        setEditing(false);
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  function commitInt() {
    void save({
      bool_value: props.boolValue,
      int_value: val.trim() === "" ? null : Number(val),
    });
  }

  if (props.type === "bool") {
    return (
      <button
        type="button"
        disabled={busy}
        className={`px-2 py-1.5 text-slate-300 hover:text-white disabled:opacity-50 ${RING}`}
        title="Toggle"
        aria-label={`Toggle ${props.featureKey} for ${props.planKey}`}
        onClick={() => void save({ bool_value: !(props.boolValue === true), int_value: props.intValue })}
      >
        {props.boolValue === true ? "✓" : "—"}
      </button>
    );
  }

  if (!editing) {
    return (
      <button
        type="button"
        className={`px-2 py-1.5 text-slate-300 hover:text-white ${RING}`}
        title="Edit limit"
        aria-label={`Edit ${props.featureKey} limit for ${props.planKey}`}
        onClick={() => setEditing(true)}
      >
        {props.intValue === null ? "∞" : props.intValue}
      </button>
    );
  }

  return (
    <span className="inline-flex items-center gap-1">
      <input
        autoFocus
        inputMode="numeric"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commitInt();
          } else if (e.key === "Escape") {
            e.preventDefault();
            setEditing(false);
          }
        }}
        placeholder="∞"
        aria-label={`${props.featureKey} limit for ${props.planKey} (blank = unlimited)`}
        className="w-14 rounded border border-slate-600 bg-slate-900 px-1 py-1.5 text-xs text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-400"
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
        onClick={() => setEditing(false)}
      >
        esc
      </button>
    </span>
  );
}
