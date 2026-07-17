"use client";

import { useCallback, useEffect, useState } from "react";
import { Copy, Check, KeyRound } from "lucide-react";
import { useConfirm } from "@/components/ui/confirm-provider";
import { Tip } from "@/components/ui/tip";
import { useMsg } from "@/components/i18n/dict-provider";
import type { MessageKey } from "@/lib/messages";

interface ApiKeyRow {
  id: string;
  name: string;
  scopes: string[];
  competition_id: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

const SCOPES = ["read", "score", "manage"] as const;
type ScopeChoice = (typeof SCOPES)[number];

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

function fmt(iso: string | null, never: string): string {
  if (!iso) return never;
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** Manage the org's platform API keys (Pro). The sc_ secret is shown
 *  exactly once, right after minting — it can never be retrieved again. */
export function ApiKeysPanel({
  orgId,
  competitions,
}: {
  orgId: string;
  /** Org competitions offered as an optional key pin (v3/08 §2). */
  competitions: { id: string; name: string }[];
}) {
  const msg = useMsg();
  const confirmDialog = useConfirm();
  const [keys, setKeys] = useState<ApiKeyRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [scope, setScope] = useState<ScopeChoice>("read");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [minted, setMinted] = useState<{ name: string; secret: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      setKeys(await v1<ApiKeyRow[]>(`/api/v1/orgs/${orgId}/api-keys`));
    } catch (err) {
      setError(err instanceof Error ? err.message : msg("apiKeys.loadFailed"));
    }
  }, [orgId, msg]);

  useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const key = await v1<ApiKeyRow & { secret: string }>(
        `/api/v1/orgs/${orgId}/api-keys`,
        {
          method: "POST",
          json: {
            name: name.trim(),
            scopes: [scope],
            competition_id: pin || undefined,
          },
        },
      );
      setMinted({ name: key.name, secret: key.secret });
      setCopied(false);
      setName("");
      setScope("read");
      setPin("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : msg("apiKeys.createFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(key: ApiKeyRow) {
    const ok = await confirmDialog({
      title: msg("confirm.revokeKey.title"),
      body: msg("confirm.revokeKey.body", { name: key.name }),
      confirmLabel: msg("confirm.revokeKey.label"),
      tone: "danger",
    });
    if (!ok) return;
    setError(null);
    try {
      await v1(`/api/v1/orgs/${orgId}/api-keys/${key.id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : msg("apiKeys.revokeFailed"));
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
            {msg("apiKeys.minted.title", { name: minted.name })}
          </p>
          <p className="mb-3 text-xs text-amber-700">
            {msg("apiKeys.minted.warning")}
          </p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-lg bg-white px-3 py-2 font-mono text-xs text-slate-800">
              {minted.secret}
            </code>
            <button type="button" onClick={copySecret} className="btn btn-ghost shrink-0 text-xs">
              {copied ? (
                <><Check className="mr-1 inline h-3.5 w-3.5 text-green-600" />{msg("apiKeys.minted.copied")}</>
              ) : (
                <><Copy className="mr-1 inline h-3.5 w-3.5" />{msg("apiKeys.minted.copy")}</>
              )}
            </button>
          </div>
          <button
            type="button"
            onClick={() => setMinted(null)}
            className="mt-3 text-xs text-amber-700 underline"
          >
            {msg("apiKeys.minted.dismiss")}
          </button>
        </div>
      )}

      {/* Create */}
      <div className="space-y-3">
        <div className="flex gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={msg("apiKeys.create.namePlaceholder")}
            maxLength={100}
            className="input flex-1"
          />
          <button
            type="button"
            onClick={create}
            disabled={busy || name.trim().length === 0}
            className="btn btn-primary px-4"
          >
            {busy ? msg("apiKeys.create.buttonBusy") : msg("apiKeys.create.button")}
          </button>
        </div>

        {/* Scope choice — one radio per scope, consequence line under each
            (v3/03 §7 pattern: say what it lets the holder do, plainly). */}
        <fieldset>
          <legend className="label flex items-center gap-1.5">
            {msg("apiKeys.scopes.legend")} <Tip id="api.key-scopes" />
          </legend>
          <div className="mt-1 grid gap-2 sm:grid-cols-3">
            {SCOPES.map((s) => (
              <label
                key={s}
                className={`cursor-pointer rounded-xl border p-3 transition ${
                  scope === s
                    ? "border-purple-400 bg-purple-50/60 ring-1 ring-purple-200"
                    : "border-slate-200 hover:border-slate-300"
                }`}
              >
                <span className="flex items-center gap-2 text-sm font-medium text-slate-800">
                  <input
                    type="radio"
                    name="key-scope"
                    value={s}
                    checked={scope === s}
                    onChange={() => setScope(s)}
                  />
                  {msg(`apiKeys.scope.${s}.label`)}
                </span>
                <span className="mt-1 block text-xs leading-relaxed text-slate-500">
                  {msg(`apiKeys.scope.${s}.line`)}
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        {competitions.length > 0 && (
          <div>
            <label className="label" htmlFor="key-pin">
              {msg("apiKeys.pin.label")}
            </label>
            <select
              id="key-pin"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              className="select mt-1 w-full sm:max-w-sm"
            >
              <option value="">{msg("apiKeys.pin.any")}</option>
              {competitions.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-slate-500">{msg("apiKeys.pin.line")}</p>
          </div>
        )}
      </div>

      {/* Active keys */}
      {keys === null ? (
        <p className="text-sm text-slate-500">{msg("apiKeys.loading")}</p>
      ) : active.length === 0 ? (
        <p className="text-sm text-slate-500">
          {msg("apiKeys.empty")}{" "}
          <code className="font-mono text-xs">Authorization: Bearer sc_…</code>
        </p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {active.map((key) => {
            const scopes = key.scopes.map((s) => (s === "write" ? "manage" : s));
            const pinned = competitions.find((c) => c.id === key.competition_id);
            return (
              <li key={key.id} className="flex items-center gap-3 py-3">
                <KeyRound className="h-4 w-4 shrink-0 text-purple-400" strokeWidth={1.75} />
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-slate-800">
                    <span className="truncate">{key.name}</span>
                    {scopes.map((s) => (
                      <span
                        key={s}
                        className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                          s === "manage"
                            ? "bg-amber-50 text-amber-700"
                            : "bg-slate-100 text-slate-600"
                        }`}
                      >
                        {msg(`apiKeys.scope.${s}.label` as MessageKey)}
                      </span>
                    ))}
                    {pinned && (
                      <span className="rounded-full bg-purple-50 px-2 py-0.5 text-[11px] font-medium text-purple-700">
                        {msg("apiKeys.pinnedOnly", { name: pinned.name })}
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-slate-500">
                    {msg("apiKeys.meta", {
                      created: fmt(key.created_at, msg("apiKeys.never")),
                      lastUsed: fmt(key.last_used_at, msg("apiKeys.never")),
                    })}
                  </p>
                  {scopes.includes("manage") && (
                    <p className="mt-0.5 text-xs text-amber-600">{msg("apiKeys.manage.nudge")}</p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => revoke(key)}
                  className="btn btn-ghost shrink-0 text-xs text-red-600"
                >
                  {msg("apiKeys.revoke")}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <p className="text-xs text-slate-500">
        {msg("apiKeys.docs.prefix")}{" "}
        <a href="/developers" className="font-medium text-purple-600 hover:underline">
          {msg("apiKeys.docs.link")} →
        </a>
      </p>

      {revoked.length > 0 && (
        <details className="text-sm text-slate-500">
          <summary className="cursor-pointer">{msg("apiKeys.revoked.summary", { n: revoked.length })}</summary>
          <ul className="mt-2 space-y-1">
            {revoked.map((key) => (
              <li key={key.id} className="text-xs">
                {msg("apiKeys.revoked.item", { name: key.name, date: fmt(key.revoked_at, msg("apiKeys.never")) })}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
