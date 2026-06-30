"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client";

/**
 * Email/password + Google sign-in. A `next` (e.g. an invite link) is carried
 * through so the user returns to it after authenticating; otherwise the server
 * decides the landing page (dashboard, auto-provisioning an org if needed).
 */
export function AuthForm({ next }: { next?: string }) {
  const router = useRouter();
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [devLink, setDevLink] = useState<string | null>(null);
  const [emailSent, setEmailSent] = useState(true);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === "signup") {
        const res = await api<{ email_sent?: boolean; verify_url?: string }>(
          "/api/auth/signup",
          { method: "POST", json: { email, password, ...(next ? { next } : {}) } },
        );
        // Account created but inactive until the emailed link is opened.
        setEmailSent(res.email_sent !== false);
        setDevLink(res.verify_url ?? null);
        setSentTo(email);
        return;
      }
      const res = await api<{ redirect: string }>("/api/auth/login", {
        method: "POST",
        json: { email, password, ...(next ? { next } : {}) },
      });
      router.push(res.redirect);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  if (sentTo) {
    return (
      <div className="card w-full max-w-sm p-6 text-center">
        <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-full bg-purple-100 text-2xl">
          ✉️
        </div>
        <h3 className="text-lg font-semibold text-purple-900">Check your email</h3>
        <p className="mt-2 text-sm text-slate-500">
          {emailSent ? (
            <>
              We sent a verification link to{" "}
              <span className="font-medium text-purple-700">{sentTo}</span>. Open
              it to finish creating your account.
            </>
          ) : (
            <>
              Your account for{" "}
              <span className="font-medium text-purple-700">{sentTo}</span> is
              ready, but the email couldn&apos;t be delivered. Use the link below
              to verify.
            </>
          )}
        </p>

        {devLink && (
          <a
            href={devLink}
            className="btn btn-primary mt-4 inline-block w-full justify-center py-2.5"
          >
            Verify now (dev link)
          </a>
        )}

        <button
          onClick={() => {
            setSentTo(null);
            setDevLink(null);
            setMode("login");
          }}
          className="btn btn-ghost mt-3"
        >
          Back to sign in
        </button>
      </div>
    );
  }

  const googleHref = next
    ? `/api/auth/google?next=${encodeURIComponent(next)}`
    : "/api/auth/google";

  return (
    <div className="card w-full max-w-sm p-6">
      <div className="mb-5 grid grid-cols-2 rounded-lg bg-purple-50 p-1 text-sm">
        {(["login", "signup"] as const).map((m) => (
          <button
            key={m}
            onClick={() => {
              setMode(m);
              setError(null);
            }}
            className={`rounded-md py-1.5 font-medium capitalize transition ${
              mode === m
                ? "bg-purple-600 text-white shadow-sm"
                : "text-purple-700 hover:text-purple-900"
            }`}
          >
            {m === "login" ? "Sign in" : "Create account"}
          </button>
        ))}
      </div>

      <a href={googleHref} className="btn btn-ghost mb-4 w-full justify-center py-2.5">
        <GoogleMark />
        <span className="ml-2">Continue with Google</span>
      </a>

      <div className="mb-4 flex items-center gap-3 text-xs text-slate-400">
        <span className="h-px flex-1 bg-purple-100" />
        or
        <span className="h-px flex-1 bg-purple-100" />
      </div>

      <form onSubmit={submit} className="space-y-3">
        <Field
          label="Email"
          value={email}
          onChange={setEmail}
          type="email"
          placeholder="you@example.com"
          autoComplete="email"
        />
        <div>
          <Field
            label="Password"
            value={password}
            onChange={setPassword}
            type="password"
            placeholder="••••••••"
            autoComplete={mode === "login" ? "current-password" : "new-password"}
          />
          {mode === "login" && (
            <a
              href="/forgot-password"
              className="mt-1 block text-right text-xs text-purple-600 hover:underline"
            >
              Forgot password?
            </a>
          )}
        </div>

        {error && (
          <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">
            {error}
          </p>
        )}

        <button disabled={busy} className="btn btn-primary w-full py-2.5">
          {busy ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}
        </button>
      </form>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
  autoComplete,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  autoComplete?: string;
}) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        autoComplete={autoComplete}
        onChange={(e) => onChange(e.target.value)}
        className="input"
      />
    </label>
  );
}

function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.71-1.57 2.68-3.89 2.68-6.62Z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.81.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z"
      />
      <path
        fill="#FBBC05"
        d="M3.97 10.72A5.4 5.4 0 0 1 3.68 9c0-.6.1-1.18.29-1.72V4.95H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.05l3.01-2.33Z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z"
      />
    </svg>
  );
}
