"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { TOUR_STORAGE_KEY } from "@/components/product-tour";
import { useMsg } from "@/components/i18n/dict-provider";

export function TourReplayButton() {
  const msg = useMsg();
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function replay() {
    setBusy(true);
    try {
      await fetch("/api/tour", { method: "DELETE" });
      sessionStorage.removeItem(TOUR_STORAGE_KEY);
      router.push("/dashboard");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center justify-between gap-4">
      <p className="text-sm text-slate-500">{msg("settings.org.tour.desc")}</p>
      <button type="button" onClick={replay} disabled={busy} className="btn btn-ghost shrink-0 text-xs">
        {busy ? msg("settings.org.tour.starting") : msg("settings.org.tour.replay")}
      </button>
    </div>
  );
}
