"use client";

import { LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import posthog from "posthog-js";
import { api } from "@/lib/client";
import { clearAnalyticsIdentity } from "@/lib/analytics-identity";

export function LogoutButton() {
  const router = useRouter();
  return (
    <button
      onClick={async () => {
        await api("/api/auth/logout", { method: "POST" });
        // Kill the analytics identity BEFORE the (soft) navigation — the
        // cached identify payload and posthog distinct id would otherwise
        // outlive the session and misattribute the next user in this tab
        // (task-8 review, Critical). Guarded: must never block logout.
        try {
          clearAnalyticsIdentity();
          if (posthog.__loaded) posthog.reset();
        } catch {
          /* analytics teardown is best-effort */
        }
        router.push("/login");
        router.refresh();
      }}
      className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-medium text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700"
      title="Sign out"
    >
      <LogOut className="h-4 w-4" strokeWidth={1.75} />
      <span className="hidden sm:inline">Sign out</span>
    </button>
  );
}
