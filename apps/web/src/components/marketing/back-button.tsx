"use client";

import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";

/** One back arrow at the top of every marketing subpage (12 Jul feedback).
 *  Browser back when there is history, home otherwise. */
export function BackButton() {
  const router = useRouter();
  return (
    <button
      type="button"
      aria-label="Back"
      onClick={() => {
        if (window.history.length > 1) router.back();
        else router.push("/");
      }}
      className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-purple-200 bg-white text-purple-700 transition hover:border-purple-400 hover:bg-purple-50"
    >
      <ArrowLeft className="h-4.5 w-4.5" strokeWidth={2} />
    </button>
  );
}
