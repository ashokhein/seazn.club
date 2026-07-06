"use client";

import { useCallback, useEffect, useState } from "react";
import { Copy, Check, KeyRound } from "lucide-react";

interface ApiKeyRow {
  id: string;
  name: string;
  scopes: string[];
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

/** /api/v1 fetch helper: unwraps the {ok, data} envelope and surfaces
 *  error.message (v1 errors are objects, unlike the /api/orgs endpoints). */
async function v1<T>(url: string, options?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = options ?? {};
  const res = await fetch(url, {
    ...rest,
    headers: { "Content-Type": "application/json", ...(rest.headers ?? {}) },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || payload?.ok === false) {
    throw new Error(payload?.error?.message ?? `Request failed (${res.status})`);
  }
  return payload.data as T;
}

function fmt(iso: string | null): string {
  if (!iso) return "never";
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** Manage the org's platform API keys (Pro). The sk_live_ secret is shown
 *  exactly once, right after minting — it can never be retrieved again. */
export function ApiKeysPanel({
  orgId,
  canWriteScope,
}: {
  orgId: string;
  /** api.write entitlement (Business): allows minting write-scoped keys. */
  canWriteScope: boolean;
}) {
  const [keys, setKeys] = useState<ApiKeyRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [wantWrite, setWantWrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [minted, setMinted] = useState<{ name: string; secret: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      setKeys(await v1<ApiKeyRow[]>(`/api/v1/orgs/${orgId}/api-keys`));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load API keys");
    }
  }, [orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const scopes = wantWrite ? ["read", "write"] : ["read"];
      const key = await v1<ApiKeyRow & { secret: string }>(
        `/api/v1/orgs/${orgId}/api-keys`,
        { method: "POST", json: { name: name.trim(), scopes } },
      );
      setMinted({ name: key.name, secret: key.secret });
      setCopied(false);
      setName("");
      setWantWrite(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create API key");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(key: ApiKeyRow) {
    if (!window.confirm(`Revoke "${key.name}"? Integrations using it will stop working immediately.`)) {
      return;
    }
    setError(null);
    try {
      await v1(`/api/v1/orgs/${orgId}/api-keys/${key.id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to revoke API key");
    }
  }

  async function copySecret() {
    if (!minted) return;
    await navigator.clipboard.writeText(minted.secret);
    setCopied(true);
  }

  const active = keys?.filter((k) => !k.revoked_at) ?? [];
  const revoked = keys?.filter((k) => k.revoked_at) ?? [];

  return (
    <div className="space-y-5">
      {error && (
        <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {/* One-time secret reveal */}
      {minted && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
          <p className="mb-2 text-sm font-semibold text-amber-800">
            Key “{minted.name}” created — copy the secret now
          </p>
          <p className="mb-3 text-xs text-amber-700">
            This is the only time it will be shown. Store it somewhere safe.
          </p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-lg bg-white px-3 py-2 font-mono text-xs text-slate-800">
              {minted.secret}
            </code>
            <button type="button" onClick={copySecret} className="btn btn-ghost shrink-0 text-xs">
              {copied ? (
                <><Check className="mr-1 inline h-3.5 w-3.5 text-green-600" />Copied</>
              ) : (
                <><Copy className="mr-1 inline h-3.5 w-3.5" />Copy</>
              )}
            </button>
          </div>
          <button
            type="button"
            onClick={() => setMinted(null)}
            className="mt-3 text-xs text-amber-700 underline"
          >
            I&apos;ve stored it — dismiss
          </button>
        </div>
      )}

      {/* Create */}
      <div>
        <div className="flex gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Key name, e.g. “Scoreboard integration”"
            maxLength={100}
            className="input flex-1"
          />
          <button
            type="button"
            onClick={create}
            disabled={busy || name.trim().length === 0}
            className="btn btn-primary px-4"
          >
            {busy ? "Creating…" : "Create key"}
          </button>
        </div>
        <label className="mt-2 flex items-center gap-2 text-sm text-slate-600">
          <input
            type="checkbox"
            checked={wantWrite}
            onChange={(e) => setWantWrite(e.target.checked)}
            disabled={!canWriteScope}
          />
          Allow writes
          {!canWriteScope && (
            <span className="text-xs text-slate-400">(read-only on Pro — writes need Business)</span>
          )}
        </label>
      </div>

      {/* Active keys */}
      {keys === null ? (
        <p className="text-sm text-slate-400">Loading…</p>
      ) : active.length === 0 ? (
        <p className="text-sm text-slate-400">
          No API keys yet. Create one to call the platform API with{" "}
          <code className="font-mono text-xs">Authorization: Bearer sk_live_…</code>
        </p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {active.map((key) => (
            <li key={key.id} className="flex items-center gap-3 py-3">
              <KeyRound className="h-4 w-4 shrink-0 text-purple-400" strokeWidth={1.75} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-slate-800">{key.name}</p>
                <p className="text-xs text-slate-400">
                  {key.scopes.join(" + ")} · created {fmt(key.created_at)} · last used{" "}
                  {fmt(key.last_used_at)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => revoke(key)}
                className="btn btn-ghost shrink-0 text-xs text-red-600"
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}

      {revoked.length > 0 && (
        <details className="text-sm text-slate-400">
          <summary className="cursor-pointer">Revoked keys ({revoked.length})</summary>
          <ul className="mt-2 space-y-1">
            {revoked.map((key) => (
              <li key={key.id} className="text-xs">
                {key.name} · revoked {fmt(key.revoked_at)}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
