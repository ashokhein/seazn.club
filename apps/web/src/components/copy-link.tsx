"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";

/** Shows an absolute share URL (origin + path) with a one-click copy button.
 *  Pass `qrFileName` to add a QR reveal — a printable code for noticeboards
 *  (generated client-side from the same URL, downloadable as a PNG). */
export function CopyLink({ path, qrFileName }: { path: string; qrFileName?: string }) {
  const [origin, setOrigin] = useState("");
  const [copied, setCopied] = useState(false);
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [showQr, setShowQr] = useState(false);
  useEffect(() => setOrigin(window.location.origin), []);
  const url = origin ? `${origin}${path}` : path;

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — the field is selectable as a fallback */
    }
  }

  async function toggleQr() {
    if (!showQr && qrUrl === null) {
      // 1000px stays sharp on an A4 print; the preview scales it down.
      setQrUrl(await QRCode.toDataURL(url, { margin: 1, width: 1000 }));
    }
    setShowQr(!showQr);
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          readOnly
          value={url}
          onFocus={(e) => e.currentTarget.select()}
          className="min-w-0 flex-1 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 font-mono text-xs text-slate-600"
        />
        <button type="button" onClick={copy} className="btn btn-ghost text-xs">
          {copied ? "Copied ✓" : "Copy"}
        </button>
        <a href={path} target="_blank" rel="noopener" className="btn btn-ghost text-xs">
          Open ↗
        </a>
        {qrFileName && (
          <button type="button" onClick={toggleQr} aria-expanded={showQr} className="btn btn-ghost text-xs">
            {showQr ? "Hide QR" : "QR"}
          </button>
        )}
      </div>
      {qrFileName && showQr && qrUrl && (
        <div className="mt-3 flex flex-wrap items-center gap-4">
          {/* eslint-disable-next-line @next/next/no-img-element -- data URL, generated client-side */}
          <img
            src={qrUrl}
            alt={`QR code opening ${url}`}
            width={176}
            height={176}
            data-testid="reg-link-qr"
            className="rounded-md border border-slate-200 bg-white p-2"
          />
          <div className="space-y-2 text-xs text-slate-500">
            <p className="max-w-56">
              Scan with a phone camera to open this link — print it for the club noticeboard.
            </p>
            <a href={qrUrl} download={qrFileName} className="btn btn-ghost text-xs">
              Download PNG
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
