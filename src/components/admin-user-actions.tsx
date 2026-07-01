"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function AdminUserActions({
  userId,
  emailVerified,
  isDeleted,
}: {
  userId: string;
  emailVerified: boolean;
  isDeleted: boolean;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [impersonateUrl, setImpersonateUrl] = useState("");

  async function post(path: string) {
    setLoading(path);
    setError("");
    try {
      const res = await fetch(`/api/admin/users/${userId}/${path}`, { method: "POST" });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? "Failed");
      }
      const body = await res.json();
      // handler() wraps payloads as { ok: true, data: {...} }
      if (path === "impersonate") setImpersonateUrl(body.data.url);
      else router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error");
    } finally {
      setLoading(null);
    }
  }

  return (
    <div className="space-y-3">
      {!emailVerified && !isDeleted && (
        <button
          onClick={() => post("resend-verification")}
          disabled={loading === "resend-verification"}
          className="w-full rounded bg-slate-700 px-3 py-1.5 text-xs text-white hover:bg-slate-600 disabled:opacity-50"
        >
          {loading === "resend-verification" ? "Sending…" : "Resend verification email"}
        </button>
      )}

      {!isDeleted && (
        <div className="space-y-1">
          <button
            onClick={() => post("impersonate")}
            disabled={loading === "impersonate"}
            className="w-full rounded bg-amber-800 px-3 py-1.5 text-xs text-white hover:bg-amber-700 disabled:opacity-50"
          >
            {loading === "impersonate" ? "Creating session…" : "Impersonate (1h, read-only)"}
          </button>
          {impersonateUrl && (
            <div className="rounded border border-amber-700 bg-amber-900/30 p-2">
              <p className="text-xs text-amber-300 mb-1">One-time link (1 hour):</p>
              <a
                href={impersonateUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-amber-200 underline break-all"
              >
                {impersonateUrl}
              </a>
            </div>
          )}
        </div>
      )}

      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
