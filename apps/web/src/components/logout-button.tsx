"use client";

import { LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client";

export function LogoutButton() {
  const router = useRouter();
  return (
    <button
      onClick={async () => {
        await api("/api/auth/logout", { method: "POST" });
        router.push("/login");
        router.refresh();
      }}
      // Lives only on night chrome (gantry + my-matches header) — cream it is.
      className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-medium text-cream/70 transition-colors hover:bg-cream/10 hover:text-cream"
      title="Sign out"
    >
      <LogOut className="h-4 w-4" strokeWidth={1.75} />
      <span className="hidden sm:inline">Sign out</span>
    </button>
  );
}
