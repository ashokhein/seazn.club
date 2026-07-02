"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client";

/** Calls the verify-email API with the token, signs in, then routes onward. */
export function VerifyEmail({
  token,
  next,
}: {
  token: string | null;
  next: string | null;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<"working" | "ok" | "error">("working");
  const [error, setError] = useState<string | null>(null);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    if (!token) {
      setStatus("error");
      setError("Missing verification token.");
      return;
    }
    api<{ redirect: string }>("/api/auth/verify-email", {
      method: "POST",
      json: { token, ...(next ? { next } : {}) },
    })
      .then((res) => {
        setStatus("ok");
        router.push(res.redirect || "/dashboard");
        router.refresh();
      })
      .catch((e) => {
        setStatus("error");
        setError(e instanceof Error ? e.message : "Verification failed");
      });
  }, [token, next, router]);

  return (
    <div className="card p-6 text-center">
      {status === "working" && (
        <>
          <h1 className="text-xl font-bold text-purple-900">Verifying…</h1>
          <p className="mt-2 text-sm text-slate-500">
            Confirming your email and signing you in.
          </p>
        </>
      )}
      {status === "ok" && (
        <>
          <h1 className="text-xl font-bold text-purple-900">Email verified</h1>
          <p className="mt-2 text-sm text-slate-500">Taking you to setup…</p>
        </>
      )}
      {status === "error" && (
        <>
          <h1 className="text-xl font-bold text-purple-900">
            Verification failed
          </h1>
          <p className="mt-2 text-sm text-red-600">{error}</p>
          <Link
            href="/login"
            className="btn btn-primary mt-4 inline-block px-4"
          >
            Back to sign in
          </Link>
        </>
      )}
    </div>
  );
}
