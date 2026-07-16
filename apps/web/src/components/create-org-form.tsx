"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client";
import { useMsg } from "@/components/i18n/dict-provider";

/** Create an organization; the creator becomes its owner. Slug is automatic. */
export function CreateOrgForm() {
  const msg = useMsg();
  const router = useRouter();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api("/api/orgs", { method: "POST", json: { name } });
      router.push("/dashboard");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : msg("orgNew.failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="card space-y-4 p-6">
      <label className="block">
        <span className="label">{msg("orgNew.nameLabel")}</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={msg("orgNew.namePlaceholder")}
          className="input"
          autoFocus
        />
        <span className="mt-1 block text-xs text-slate-400">
          {msg("orgNew.renameHint")}
        </span>
      </label>

      {error && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">
          {error}
        </p>
      )}

      <button
        disabled={busy || name.trim().length < 1}
        className="btn btn-primary w-full py-2.5"
      >
        {busy ? msg("orgNew.creating") : msg("orgNew.create")}
      </button>
    </form>
  );
}
