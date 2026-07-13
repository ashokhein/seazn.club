"use client";

// Player-account claim controls (PROMPT-53): per-person invite → pending →
// claimed lifecycle in the Directory. The invite modal shows the one-time
// claim link + QR (invite-scorer pattern) — the email goes out too, but the
// print-at-the-club path never depends on inboxes.
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
  const [qr, setQr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmUnlink, setConfirmUnlink] = useState(false);

  async function invite() {
    setBusy(true);
    setError(null);
    try {
      const out = await apiV1<{ claim_url: string }>(
        `/api/v1/persons/${personId}/claim-invites`,
        { method: "POST", json: { email } },
      );
      setLink(out.claim_url);
      const QRCode = (await import("qrcode")).default;
      setQr(await QRCode.toDataURL(out.claim_url, { width: 240, margin: 1 }));
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
    setQr(null);
    setEmail("");
    setCopied(false);
    setError(null);
  };

  if (claimed) {
    return (
      <span className="inline-flex items-center gap-2">
        <span className="badge bg-emerald-100 text-emerald-700">{msg("claim.claimed")}</span>
        <button
          type="button"
          disabled={busy}
          onClick={() => setConfirmUnlink(true)}
          className="text-slate-400 hover:text-red-600 hover:underline"
        >
          {msg("claim.unlink").toLowerCase()}
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
        <>
          <span className="badge bg-amber-100 text-amber-700">{msg("claim.invited")}</span>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              run(() => apiV1(`/api/v1/persons/${personId}/claim-invites`, { method: "DELETE" }))
            }
            className="text-slate-400 hover:text-red-600 hover:underline"
          >
            {msg("claim.revoke").toLowerCase()}
          </button>
        </>
      ) : (
        !modal && (
          <button
            type="button"
            disabled={busy}
            onClick={() => setModal(true)}
            className="text-slate-400 hover:text-purple-600 hover:underline"
          >
            {msg("claim.invite").toLowerCase()}…
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
                {qr && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={qr}
                    alt={`QR code for ${personName}'s claim link`}
                    className="mx-auto rounded-lg border border-slate-200 p-1"
                    width={176}
                    height={176}
                    data-testid="claim-qr"
                  />
                )}
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
