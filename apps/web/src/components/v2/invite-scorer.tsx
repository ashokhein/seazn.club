"use client";

// Scorer invite (doc 13 §4, PROMPT-18): one tap creates a share link / QR
// whose acceptance grants the scorer role + a division-scoped assignment
// atomically. The button label is sport-aware (doc 13 §1): "Invite an Umpire".
import { useState } from "react";
import { api } from "@/lib/client";
import { UpgradeGate } from "@/components/upgrade-gate";
import { useMsg } from "@/components/i18n/dict-provider";

interface Props {
  orgId: string;
  divisionId: string;
  /** SportModule.officialLabel.scorer — 'Umpire' / 'Referee' / 'Arbiter' / 'Scorer'. */
  officialLabel: string;
}

export function InviteScorer({ orgId, divisionId, officialLabel }: Props) {
  const msg = useMsg();
  const [link, setLink] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paywall, setPaywall] = useState(false);
  const [copied, setCopied] = useState(false);

  async function invite() {
    setBusy(true);
    setError(null);
    try {
      const out = await api<{ token: string }>(`/api/orgs/${orgId}/invites`, {
        method: "POST",
        json: {
          role: "scorer",
          max_uses: 1,
          default_scope: { type: "division", id: divisionId },
        },
      });
      const url = `${window.location.origin}/join/${out.token}`;
      setLink(url);
      const QRCode = (await import("qrcode")).default;
      setQr(await QRCode.toDataURL(url, { width: 240, margin: 1 }));
    } catch (err) {
      const message = err instanceof Error ? err.message : msg("inviteScorer.failed");
      // The 402 quota path renders the contextual paywall (message is the
      // PaymentRequiredError's "Plan upgrade required: <feature_key>").
      if (message.startsWith("Plan upgrade required")) setPaywall(true);
      else setError(message);
    } finally {
      setBusy(false);
    }
  }

  if (paywall) return <UpgradeGate feature="scorers.max" compact />;

  const close = () => {
    setLink(null);
    setQr(null);
    setCopied(false);
  };

  if (link) {
    // Modal (v8): the link + QR present as one shareable card — hand the
    // phone over or let them scan across the table.
    return (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
        role="dialog"
        aria-modal="true"
        aria-label={msg("inviteScorer.title", { label: officialLabel })}
        onClick={close}
      >
        <div
          className="w-full max-w-sm space-y-3 rounded-xl bg-white p-5 shadow-xl"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-start justify-between gap-2">
            <h2 className="text-sm font-semibold text-slate-800">
              {msg("inviteScorer.title", { label: officialLabel.toLowerCase() })}
            </h2>
            <button
              type="button"
              aria-label={msg("inviteScorer.close")}
              onClick={close}
              className="-m-1 p-1 text-slate-400 hover:text-slate-700"
            >
              ✕
            </button>
          </div>
          {qr && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={qr}
              alt={msg("inviteScorer.alt", { label: officialLabel })}
              className="mx-auto rounded-lg border border-slate-200 p-1"
              width={176}
              height={176}
              data-testid="invite-qr"
            />
          )}
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-slate-100 px-2 py-1.5 text-xs text-slate-700">
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
              {copied ? msg("inviteScorer.copied") : msg("inviteScorer.copy")}
            </button>
          </div>
          <p className="text-[11px] text-slate-400">
            {msg("inviteScorer.hint", { label: officialLabel.toLowerCase() })}
          </p>
          <button type="button" onClick={close} className="btn btn-primary w-full text-xs">
            {msg("inviteScorer.done")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        disabled={busy}
        onClick={invite}
        className="btn btn-ghost px-3 py-1.5 text-xs"
      >
        {busy ? msg("inviteScorer.creating") : msg("inviteScorer.title", { label: officialLabel })}
      </button>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </span>
  );
}
