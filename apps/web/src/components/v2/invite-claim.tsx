"use client";

// Player-account claim controls (PROMPT-53): per-person invite → pending →
// claimed lifecycle in the Directory. Email is the channel (owner decision
// 2026-07-13 — claims are strictly bound to the invited address, so a QR has
// no claim path anymore); the modal reports the send outcome honestly and
// keeps the one-time link as a manual fallback.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiV1 } from "@/lib/client-v1";
import { msg } from "@/lib/messages";
import { ConfirmDialog } from "@/components/v2/confirm-dialog";

interface Props {
  personId: string;
  personName: string;
  claimed: boolean;
  claimPending: boolean;
}

export function InviteClaim({ personId, personName, claimed, claimPending }: Props) {
  const router = useRouter();
  const [modal, setModal] = useState(false);
  const [email, setEmail] = useState("");
  const [link, setLink] = useState<string | null>(null);
  const [emailSent, setEmailSent] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmUnlink, setConfirmUnlink] = useState(false);

  async function invite() {
    setBusy(true);
    setError(null);
    try {
      const out = await apiV1<{ claim_url: string; email_sent: boolean }>(
        `/api/v1/persons/${personId}/claim-invites`,
        { method: "POST", json: { email } },
      );
      setLink(out.claim_url);
      setEmailSent(out.email_sent);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  const close = () => {
    setModal(false);
    setLink(null);
    setEmail("");
    setCopied(false);
    setError(null);
  };

  // State chips live in the table's Account column — this component renders
  // only the verbs.
  if (claimed) {
    return (
      <span className="inline-flex items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => setConfirmUnlink(true)}
          title={msg("claim.unlink.tip")}
          className="btn btn-ghost px-2 py-1 text-xs text-red-600 hover:bg-red-50"
        >
          {msg("claim.unlink")}
        </button>
        <ConfirmDialog
          open={confirmUnlink}
          title={msg("confirm.unlinkPlayer.title")}
          confirmLabel={msg("confirm.unlinkPlayer.label")}
          busy={busy}
          onCancel={() => setConfirmUnlink(false)}
          onConfirm={() =>
            run(async () => {
              await apiV1(`/api/v1/persons/${personId}/unlink`, { method: "POST" });
              setConfirmUnlink(false);
            })
          }
        >
          {msg("confirm.unlinkPlayer.body", { name: personName })}
        </ConfirmDialog>
        {error && <span className="text-xs text-red-600">{error}</span>}
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-2">
      {claimPending && !modal ? (
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            run(() => apiV1(`/api/v1/persons/${personId}/claim-invites`, { method: "DELETE" }))
          }
          title={msg("claim.revoke.tip")}
          className="btn btn-ghost px-2 py-1 text-xs"
        >
          {msg("claim.revoke")}
        </button>
      ) : (
        !modal && (
          <button
            type="button"
            disabled={busy}
            onClick={() => setModal(true)}
            title={msg("claim.invite.tip")}
            className="btn btn-ghost px-2 py-1 text-xs text-purple-700"
          >
            {msg("claim.invite")}…
          </button>
        )
      )}
      {error && !modal && <span className="text-xs text-red-600">{error}</span>}

      {modal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-label={msg("claim.invite.title", { name: personName })}
          onClick={close}
        >
          <div
            className="w-full max-w-sm space-y-3 rounded-xl bg-white p-5 text-left shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-2">
              <h2 className="text-sm font-semibold text-slate-800">
                {msg("claim.invite.title", { name: personName })}
              </h2>
              <button
                type="button"
                aria-label="Close"
                onClick={close}
                className="-m-1 p-1 text-slate-400 hover:text-slate-700"
              >
                ✕
              </button>
            </div>

            {link ? (
              <>
                {emailSent ? (
                  <p
                    className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700"
                    data-testid="claim-emailed"
                  >
                    {msg("claim.invite.sent", { email })}
                  </p>
                ) : (
                  // Send failure is the ONLY time the link shows — the
                  // organiser needs a way out, and only the invited address
                  // can accept it anyway (strict match).
                  <>
                    <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-700">
                      {msg("claim.invite.sendFailed")}
                    </p>
                    <div className="flex items-center gap-2">
                      <code
                        className="min-w-0 flex-1 truncate rounded bg-slate-100 px-2 py-1.5 text-xs text-slate-700"
                        data-testid="claim-link"
                      >
                        {link}
                      </code>
                      <button
                        type="button"
                        className="btn btn-ghost px-2 py-1 text-xs"
                        onClick={() => {
                          void navigator.clipboard.writeText(link);
                          setCopied(true);
                        }}
                      >
                        {copied ? "Copied" : "Copy"}
                      </button>
                    </div>
                  </>
                )}
                <p className="text-[11px] text-slate-400">{msg("claim.invite.linkNote")}</p>
                <button type="button" onClick={close} className="btn btn-primary w-full text-xs">
                  Done
                </button>
              </>
            ) : (
              <form
                className="space-y-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  void invite();
                }}
              >
                <p className="text-xs text-slate-500">{msg("claim.invite.explain")}</p>
                <label className="block">
                  <span className="label">{msg("claim.invite.email")}</span>
                  <input
                    type="email"
                    required
                    autoFocus
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="input"
                    placeholder="player@example.com"
                  />
                </label>
                {error && <p className="text-xs text-red-600">{error}</p>}
                <button
                  type="submit"
                  disabled={busy || !email.trim()}
                  className="btn btn-primary w-full text-xs"
                >
                  {busy ? msg("claim.invite.sending") : msg("claim.invite.send")}
                </button>
              </form>
            )}
          </div>
        </div>
      )}
    </span>
  );
}
