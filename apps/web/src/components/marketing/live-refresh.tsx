"use client";

// Keeps /live current without a reload: re-fetches the server payload every
// 45s (the discovery cache itself refreshes every 30s), but only while the
// tab is actually visible — a phone parked on the wall shouldn't poll from
// a pocket.
import { useEffect } from "react";
import { useRouter } from "next/navigation";

export function LiveRefresh({ seconds = 45 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") router.refresh();
    };
    const id = setInterval(tick, seconds * 1000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [router, seconds]);
  return null;
}
