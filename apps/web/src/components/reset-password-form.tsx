"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client";
import Link from "next/link";

export function ResetPasswordForm({ token }: { token: string | null }) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!token) {
    return (
      <div className="card p-6 text-center">
        <p className="text-sm text-red-600">
          This reset link is missing a token. Please request a new one.
        </p>
        <Link href="/forgot-password" className="btn btn-primary mt-4 inline-block">
          Request new link
        </Link>
      </div>
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    if (password.length < 6) {
      setError("Password must be at least 6 characters.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await api("/api/auth/reset-password", {
        method: "POST",
        json: { token, password },
      });
      router.push("/login?reset=1");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card p-6">
      <h2 className="mb-1 text-lg font-semibold text-purple-900">Choose a new password</h2>
      <p className="mb-5 text-sm text-slate-500">
        Your new password must be at least 6 characters.
      </p>
      <form onSubmit={submit} className="space-y-3">
        <label className="block">
          <span className="label">New password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            autoComplete="new-password"
            required
            minLength={6}
            className="input"
          />
        </label>
        <label className="block">
          <span className="label">Confirm password</span>
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="••••••••"
            autoComplete="new-password"
            required
            className="input"
          />
        </label>
        {error && (
          <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>
        )}
        <button disabled={busy} className="btn btn-primary w-full py-2.5">
          {busy ? "Saving…" : "Reset password"}
        </button>
      </form>
    </div>
  );
}
