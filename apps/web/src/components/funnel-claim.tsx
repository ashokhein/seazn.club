"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client";

/** Consumes a funnel draft token: signs the visitor in, creates the drafted
 *  competition, and routes inside it (v3/07 §6). Mirrors <MagicLink>. */
export function FunnelClaim({ token }: { token: string | null }) {
  const router = useRouter();
  const [status, setStatus] = useState<"working" | "ok" | "error">("working");
  const [error, setError] = useState<string | null>(null);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    if (!token) {
      setStatus("error");
      setError("Missing setup token.");
      return;
    }
    api<{ redirect: string }>("/api/funnel/claim", {
      method: "POST",
      json: { token },
    })
      .then((res) => {
        setStatus("ok");
        router.push(res.redirect || "/dashboard");
        router.refresh();
      })
      .catch((e) => {
        setStatus("error");
        setError(e instanceof Error ? e.message : "Setup failed");
      });
  }, [token, router]);

  return (
    <div className="card p-6 text-center" data-funnel-claim>
      {status === "working" && (
        <>
          <div className="mb-3 text-4xl">🏗️</div>
          <p className="font-semibold text-slate-800">Creating your competition…</p>
          <p className="mt-1 text-sm text-slate-500">
            Signing you in and drawing up the structure.
          </p>
        </>
      )}
      {status === "ok" && (
        <p className="text-sm text-slate-600">Done — taking you inside…</p>
      )}
      {status === "error" && (
        <>
          <div className="mb-3 text-4xl">⛔</div>
          <p className="font-semibold text-slate-800">This link didn’t work</p>
          <p className="mt-1 text-sm text-red-600">{error}</p>
          <p className="mt-4 text-sm text-slate-500">
            Setup links work once and expire after 7 days.{" "}
            <Link href="/start" className="font-medium text-purple-700 underline">
              Start again
            </Link>{" "}
            or{" "}
            <Link href="/login" className="font-medium text-purple-700 underline">
              sign in
            </Link>
            .
          </p>
        </>
      )}
    </div>
  );
}
