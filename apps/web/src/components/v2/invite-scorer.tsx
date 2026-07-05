"use client";

// Scorer invite (doc 13 §4, PROMPT-18): one tap creates a share link / QR
// whose acceptance grants the scorer role + a division-scoped assignment
// atomically. The button label is sport-aware (doc 13 §1): "Invite an Umpire".
import { useState } from "react";
import { api } from "@/lib/client";
import { UpgradeGate } from "@/components/upgrade-gate";

interface Props {
  orgId: string;
  divisionId: string;
  /** SportModule.officialLabel.scorer — 'Umpire' / 'Referee' / 'Arbiter' / 'Scorer'. */
  officialLabel: string;
}

export function InviteScorer({ orgId, divisionId, officialLabel }: Props) {
  const [link, setLink] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paywall, setPaywall] = useState(false);
  const [copied, setCopied] = useState(false);

  const article = /^[aeiou]/i.test(officialLabel) ? "an" : "a";

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
      const message = err instanceof Error ? err.message : "Failed";
      // The 402 quota path renders the contextual paywall (message is the
      // PaymentRequiredError's "Plan upgrade required: <feature_key>").
      if (message.startsWith("Plan upgrade required")) setPaywall(true);
      else setError(message);
    } finally {
      setBusy(false);
    }
  }

  if (paywall) return <UpgradeGate feature="scorers.max" compact />;

  if (link) {
    return (
      <span className="inline-flex flex-col items-start gap-2">
        <span className="inline-flex items-center gap-2">
          <code className="max-w-64 truncate rounded bg-slate-100 px-2 py-1 text-xs text-slate-700">
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
        </span>
        {qr && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={qr}
            alt={`QR code inviting ${article} ${officialLabel} to this division`}
            className="rounded border border-slate-200"
            width={120}
            height={120}
          />
        )}
        <span className="text-[11px] text-slate-400">
          Valid 1 hour, single use — whoever joins becomes this division&apos;s{" "}
          {officialLabel.toLowerCase()}.
        </span>
      </span>
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
        {busy ? "Creating…" : `Invite ${article} ${officialLabel}`}
      </button>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </span>
  );
}
