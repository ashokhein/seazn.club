"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client";

export function CreateSeasonForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function close() {
    setOpen(false);
    setName("");
    setSlug("");
    setError(null);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api("/api/seasons", { method: "POST", json: { name, slug } });
      close();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative">
      <button
        onClick={() => (open ? close() : setOpen(true))}
        className="btn btn-ghost"
      >
        + New season
      </button>

      {open && (
        <form
          onSubmit={submit}
          className="card absolute right-0 z-20 mt-2 w-72 space-y-4 p-4 text-left shadow-lg"
        >
          <p className="text-sm text-slate-500">
            Seasons group your tournaments (for example a year or a league).
          </p>
          <label className="block">
            <span className="label">Name</span>
            <input
              autoFocus
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setSlug(
                  e.target.value
                    .toLowerCase()
                    .replace(/[^a-z0-9]+/g, "-")
                    .replace(/^-|-$/g, ""),
                );
              }}
              placeholder="SAFE 2028"
              className="input"
            />
          </label>
          <label className="block">
            <span className="label">Slug</span>
            <input
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="safe2028"
              className="input"
            />
            <span className="mt-1 block text-xs text-slate-400">
              Used in links. Lowercase letters, numbers and dashes.
            </span>
          </label>
          {error && (
            <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={close} className="btn btn-ghost">
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy || !name.trim()}
              className="btn btn-primary"
            >
              {busy ? "Creating…" : "Create"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
