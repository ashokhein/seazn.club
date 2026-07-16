"use client";

// "Hand this device over" (doc 13 §7, PROMPT-21): organiser mints a day-of
// device link for the fixture → QR + link + revoke. The secret exists only in
// this component's state after mint — the server stores its sha256 only.
import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { UpgradeGate } from "@/components/upgrade-gate";
import { useMsg } from "@/components/i18n/dict-provider";

interface ActiveLink {
  id: string;
  label: string | null;
  expires_at: string;
  created_at: string;
}

export function DeviceLinkPanel({
  fixtureId,
  scorerLabel,
}: {
  fixtureId: string;
  /** Sport-aware copy (doc 13 §1): 'Umpire' / 'Referee' / 'Arbiter' / 'Scorer'. */
  scorerLabel: string;
}) {
  const msg = useMsg();
  const [active, setActive] = useState<ActiveLink | null>(null);
  const [minted, setMinted] = useState<{ secret: string; qr: string; expires_at: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paywall, setPaywall] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setActive(await apiV1<ActiveLink | null>(`/api/v1/fixtures/${fixtureId}/device-links`));
    } catch {
      // non-editor or transient — panel just shows the mint button
    }
  }, [fixtureId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function mint() {
    setBusy(true);
    setError(null);
    setPaywall(false);
    try {
      const link = await apiV1<ActiveLink & { secret: string }>(
        `/api/v1/fixtures/${fixtureId}/device-links`,
        { method: "POST", json: {} },
      );
      const url = `${window.location.origin}/score/${link.secret}`;
      const qr = await QRCode.toDataURL(url, { width: 280, margin: 1 });
      setMinted({ secret: link.secret, qr, expires_at: link.expires_at });
      await refresh();
    } catch (err) {
      if (err instanceof ApiV1Error && err.code === "PAYMENT_REQUIRED") setPaywall(true);
      else setError(err instanceof Error ? err.message : msg("dlink.failed"));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(linkId: string) {
    setBusy(true);
    setError(null);
    try {
      await apiV1(`/api/v1/fixtures/${fixtureId}/device-links/${linkId}`, { method: "DELETE" });
      setMinted(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : msg("dlink.failed"));
    } finally {
      setBusy(false);
    }
  }

  const padUrl = minted ? `${window.location.origin}/score/${minted.secret}` : null;

  return (
    <section className="card p-5">
      <h2 className="text-sm font-semibold text-slate-700">{msg("dlink.title")}</h2>
      <p className="mt-1 text-xs text-slate-500">{msg("dlink.desc", { scorer: scorerLabel.toLowerCase() })}</p>

      {paywall && <div className="mt-3"><UpgradeGate feature="scoring.device_links" /></div>}
      {error && <p className="mt-3 rounded-md bg-red-50 px-3 py-2 text-xs text-red-600">{error}</p>}

      {minted ? (
        <div className="mt-3 space-y-3 text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={minted.qr} alt={msg("dlink.alt")} className="mx-auto h-56 w-56" />
          <p className="break-all rounded bg-slate-50 px-2 py-1 font-mono text-[10px] text-slate-500">
            {padUrl}
          </p>
          <p className="text-xs text-slate-400">
            {msg("dlink.shownOnce", { date: new Date(minted.expires_at).toLocaleString() })}
          </p>
          <div className="flex justify-center gap-2">
            <button
              type="button"
              className="btn btn-ghost text-xs"
              onClick={() => padUrl && navigator.clipboard?.writeText(padUrl)}
            >
              {msg("dlink.copy")}
            </button>
            {active && (
              <button
                type="button"
                disabled={busy}
                onClick={() => revoke(active.id)}
                className="btn btn-danger text-xs"
              >
                {msg("dlink.revokeNow")}
              </button>
            )}
          </div>
        </div>
      ) : active ? (
        <div className="mt-3 space-y-2">
          <p className="text-xs text-slate-600">
            {msg("dlink.live", { date: new Date(active.expires_at).toLocaleString() })}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => revoke(active.id)}
              className="btn btn-danger text-xs"
            >
              {msg("dlink.revoke")}
            </button>
            <button type="button" disabled={busy} onClick={mint} className="btn btn-ghost text-xs">
              {msg("dlink.newLink")}
            </button>
          </div>
        </div>
      ) : (
        <button type="button" disabled={busy} onClick={mint} className="btn btn-primary mt-3">
          {busy ? "…" : msg("dlink.create")}
        </button>
      )}
    </section>
  );
}
