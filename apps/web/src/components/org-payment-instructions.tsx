"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client";

/** Org-level offline payment instructions (cash / bank transfer). Shown to
 *  registrants of paid divisions and emailed on registration while Stripe
 *  checkout is disabled. */
export function OrgPaymentInstructions({
  orgId,
  initialValue,
}: {
  orgId: string;
  initialValue: string | null;
}) {
  const router = useRouter();
  const [value, setValue] = useState(initialValue ?? "");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = value.trim() !== (initialValue ?? "").trim();

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await api(`/api/orgs/${orgId}`, {
        method: "PATCH",
        json: { payment_instructions: value.trim() || null },
      });
      setSaved(true);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setBusy(false);
    }
  }

  return (
    <label className="block">
      <span className="label">Cash / bank transfer instructions</span>
      <p className="mb-2 text-xs text-slate-500">
        Shown to registrants of paid divisions and included in their confirmation email.
        e.g. bank name, account number, sort code / IBAN, reference to use, or &ldquo;pay cash on
        the day&rdquo;.
      </p>
      <textarea
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setSaved(false);
        }}
        rows={5}
        maxLength={2000}
        placeholder={"Bank: Example Bank\nAccount name: Riverside FC\nSort code: 00-00-00\nAccount no: 12345678\nReference: your team name"}
        className="input w-full font-mono text-sm"
      />
      <div className="mt-2 flex items-center gap-3">
        <button type="button" onClick={save} disabled={busy || !dirty} className="btn btn-primary px-4">
          {busy ? "Saving…" : "Save"}
        </button>
        {error && <span className="text-xs text-red-600">{error}</span>}
        {saved && !error && <span className="text-xs text-green-600">Saved.</span>}
      </div>
    </label>
  );
}
