"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { TOUR_STORAGE_KEY } from "@/components/product-tour";

export function TourReplayButton() {
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
      <p className="text-sm text-slate-500">
        Walk through the basics again — organisation, settings and creating a competition.
      </p>
      <button type="button" onClick={replay} disabled={busy} className="btn btn-ghost shrink-0 text-xs">
        {busy ? "Starting…" : "Replay tour"}
      </button>
    </div>
  );
}
