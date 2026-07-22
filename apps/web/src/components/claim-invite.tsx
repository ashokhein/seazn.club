"use client";

import { useState } from "react";
import { useMsg } from "@/components/i18n/dict-provider";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client";
import { AuthForm } from "@/components/auth-form";
import { LegalNotice } from "@/components/legal-notice";

/**
 * One-click accept for an email invite when the visitor is NOT signed in. A new
 * or unverified invitee is signed in and joined in a single tap (the emailed
 * invite proves the inbox — same trust as a magic link). If the address already
 * has a real account the server refuses to auto-login (`needs_signin`); we then
 * reveal the normal sign-in form so a forwarded invite can never take over a
 * real account.
 */
export function ClaimInvite({ token }: { token: string }) {
  const msg = useMsg();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [needsSignin, setNeedsSignin] = useState(false);

  async function claim() {
    setError(null);
    setBusy(true);
    try {
      const out = await api<{ needs_signin?: boolean; landing?: string }>(
        `/api/invites/${token}/claim`,
        { method: "POST" },
      );
      if (out.needs_signin) {
        setNeedsSignin(true);
        return;
      }
      router.push(out.landing ?? "/dashboard");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : msg("join.failed"));
      setBusy(false);
    }
  }

  // Existing account for this address — accept requires a real sign-in.
  if (needsSignin) {
    return (
      <div className="space-y-4">
        <p className="rounded-md bg-purple-50 px-3 py-2 text-center text-sm text-purple-800">
          {msg("join.claim.signinNote")}
        </p>
        <AuthForm next={`/join/${token}`} />
      </div>
    );
  }

  return (
    <div className="card p-6">
      <p className="mb-4 text-sm text-slate-600">{msg("join.claim.prompt")}</p>
      <button
        onClick={claim}
        disabled={busy}
        className="btn btn-primary w-full py-2.5"
      >
        {busy ? msg("join.claim.busy") : msg("join.claim.cta")}
      </button>
      {error && (
        <p className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">
          {error}
        </p>
      )}
      <LegalNotice className="mt-4 text-center" />
    </div>
  );
}
