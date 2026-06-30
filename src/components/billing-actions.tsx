"use client";

import { useState } from "react";

export function UpgradeButton({
  interval,
  label,
}: {
  interval: "monthly" | "annual";
  label: string;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go() {
    setLoading(true);
    setError(null);
    const res = await fetch("/api/billing/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan_key: "pro", interval }),
    });
    const data = await res.json();
    if (data.ok && data.data?.url) {
      window.location.href = data.data.url;
    } else {
      setError(data.error ?? "Something went wrong");
      setLoading(false);
    }
  }

  return (
    <div>
      <button onClick={go} disabled={loading} className="btn btn-primary disabled:opacity-60">
        {loading ? "Redirecting…" : label}
      </button>
      {error && <p className="mt-1 text-xs text-red-500">{error}</p>}
    </div>
  );
}

export function ManageBillingButton() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go() {
    setLoading(true);
    setError(null);
    const res = await fetch("/api/billing/portal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const data = await res.json();
    if (data.ok && data.data?.url) {
      window.location.href = data.data.url;
    } else {
      setError(data.error ?? "Something went wrong");
      setLoading(false);
    }
  }

  return (
    <div>
      <button onClick={go} disabled={loading} className="btn btn-ghost disabled:opacity-60">
        {loading ? "Opening portal…" : "Manage billing →"}
      </button>
      {error && <p className="mt-1 text-xs text-red-500">{error}</p>}
    </div>
  );
}
