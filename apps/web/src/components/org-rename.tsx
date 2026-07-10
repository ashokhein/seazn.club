"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client";
import { routes } from "@/lib/routes";

/** Inline rename for the active organization (owners and admins). */
export function OrgRename({
  orgId,
  initialName,
}: {
  orgId: string;
  initialName: string;
}) {
  const router = useRouter();
  const [name, setName] = useState(initialName);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = name.trim() !== initialName && name.trim().length > 0;

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const org = await api<{ slug: string }>(`/api/orgs/${orgId}`, {
        method: "PATCH",
        json: { name: name.trim() },
      });
      setSaved(true);
      // Renames regenerate the slug (PROMPT-30) — move to the new URL; the
      // old one 301s for anyone else holding it.
      router.replace(routes.orgSettings(org.slug));
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setBusy(false);
    }
  }

  return (
    <label className="block">
      <span className="label">Organization name</span>
      <div className="flex gap-2">
        <input
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setSaved(false);
          }}
          className="input flex-1"
        />
        <button
          type="button"
          onClick={save}
          disabled={busy || !dirty}
          className="btn btn-primary px-4"
        >
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
      {error && <span className="mt-1 block text-xs text-red-600">{error}</span>}
      {saved && !error && (
        <span className="mt-1 block text-xs text-green-600">Saved.</span>
      )}
    </label>
  );
}
