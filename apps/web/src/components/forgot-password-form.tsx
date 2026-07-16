"use client";

import { useState } from "react";
import { api } from "@/lib/client";
import Link from "next/link";
import { useMsg } from "@/components/i18n/dict-provider";

export function ForgotPasswordForm() {
  const msg = useMsg();
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api("/api/auth/forgot-password", { method: "POST", json: { email } });
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : msg("auth.error"));
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div className="card p-6 text-center">
        <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-full bg-purple-100 text-2xl">
          ✉️
        </div>
        <h3 className="text-lg font-semibold text-purple-900">{msg("auth.check.title")}</h3>
        <p className="mt-2 text-sm text-slate-500">
          {msg("forgotPw.sentBody")}
        </p>
        <Link href="/login" className="btn btn-ghost mt-4 inline-block">
          {msg("auth.backToSignIn")}
        </Link>
      </div>
    );
  }

  return (
    <div className="card p-6">
      <h2 className="mb-1 text-lg font-semibold text-purple-900">{msg("forgotPw.title")}</h2>
      <p className="mb-5 text-sm text-slate-500">
        {msg("forgotPw.subtitle")}
      </p>
      <form onSubmit={submit} className="space-y-3">
        <label className="block">
          <span className="label">{msg("auth.emailLabel")}</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={msg("auth.emailPlaceholder")}
            autoComplete="email"
            required
            className="input"
          />
        </label>
        {error && (
          <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>
        )}
        <button disabled={busy} className="btn btn-primary w-full py-2.5">
          {busy ? msg("forgotPw.sending") : msg("forgotPw.sendReset")}
        </button>
      </form>
      <p className="mt-4 text-center text-sm text-slate-500">
        <Link href="/login" className="text-purple-700 hover:underline">
          {msg("auth.backToSignIn")}
        </Link>
      </p>
    </div>
  );
}
