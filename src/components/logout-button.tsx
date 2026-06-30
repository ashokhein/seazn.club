"use client";

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
      className="rounded-lg border border-purple-200 px-3 py-1.5 text-sm text-purple-700 transition hover:bg-purple-50"
    >
      Sign out
    </button>
  );
}
