"use client";

// Fixture check-in QR (PROMPT-53): one tap mints the signed day-of link and
// shows it as QR + copyable URL (invite-scorer modal pattern). Players scan
// it at the venue to mark themselves present in the lineup picker.
import { useState } from "react";
import { apiV1 } from "@/lib/client-v1";
import { useMsg } from "@/components/i18n/dict-provider";

export function CheckinQr({ fixtureId }: { fixtureId: string }) {
  const msg = useMsg();
  const [link, setLink] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function mint() {
    setBusy(true);
    setError(null);
    try {
      const out = await apiV1<{ url: string }>(`/api/v1/fixtures/${fixtureId}/checkin-link`, {
        method: "POST",
      });
      setLink(out.url);
      const QRCode = (await import("qrcode")).default;
      setQr(await QRCode.toDataURL(out.url, { width: 240, margin: 1 }));
    } catch (err) {
      setError(err instanceof Error ? err.message : msg("checkinQr.failed"));
    } finally {
      setBusy(false);
    }
  }

  const close = () => {
    setLink(null);
    setQr(null);
    setCopied(false);
  };

  if (link) {
    return (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
        role="dialog"
        aria-modal="true"
        aria-label={msg("checkinQr.dialogAria")}
        onClick={close}
      >
        <div
          className="w-full max-w-sm space-y-3 rounded-xl bg-white p-5 shadow-xl"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-start justify-between gap-2">
            <h2 className="text-sm font-semibold text-slate-800">{msg("checkinQr.title")}</h2>
            <button
              type="button"
              aria-label={msg("checkinQr.close")}
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
              alt={msg("checkinQr.alt")}
              className="mx-auto rounded-lg border border-slate-200 p-1"
              width={176}
              height={176}
              data-testid="checkin-qr"
            />
          )}
          <div className="flex items-center gap-2">
            <code
              className="min-w-0 flex-1 truncate rounded bg-slate-100 px-2 py-1.5 text-xs text-slate-700"
              data-testid="checkin-link"
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
              {copied ? msg("checkinQr.copied") : msg("checkinQr.copy")}
            </button>
          </div>
          <p className="text-[11px] text-slate-400">{msg("checkinQr.hint")}</p>
          <button type="button" onClick={close} className="btn btn-primary w-full text-xs">
            {msg("checkinQr.done")}
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
        onClick={mint}
        className="btn btn-ghost px-3 py-1.5 text-xs"
      >
        {busy ? msg("checkinQr.creating") : msg("checkinQr.button")}
      </button>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </span>
  );
}
