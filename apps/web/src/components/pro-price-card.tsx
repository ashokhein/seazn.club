"use client";

import { useState } from "react";
import Link from "next/link";

interface Props {
  /** Pre-formatted, currency-correct strings from the server page. */
  monthly: string;
  annualPerMonth: string;
  annualTotal: string;
  features: string[];
}

/** Pro pricing card with the annual toggle DEFAULT-ON (v3/07 §4): the yearly
 *  price is the real offer — "$13.25/mo billed yearly — save 30%". */
export function ProPriceCard({ monthly, annualPerMonth, annualTotal, features }: Props) {
  const [annual, setAnnual] = useState(true);

  return (
    <div className="card relative flex flex-col border-purple-400 bg-purple-50 p-8">
      <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-purple-500">Pro</p>

      <p className="mb-1 text-4xl font-bold text-purple-900">
        {annual ? annualPerMonth : monthly}
        <span className="text-lg font-normal text-slate-500">/month</span>
      </p>
      <p className="mb-3 text-sm text-slate-500">
        {annual ? (
          <>
            {annualTotal} billed yearly —{" "}
            <span className="font-semibold text-emerald-600">save 30%</span>
          </>
        ) : (
          "Billed monthly · switch to yearly any time"
        )}
      </p>

      <label className="mb-6 inline-flex w-fit cursor-pointer items-center gap-2 text-sm text-slate-600">
        <button
          type="button"
          role="switch"
          aria-checked={annual}
          data-annual-toggle
          onClick={() => setAnnual(!annual)}
          className={`relative h-5 w-9 rounded-full transition-colors ${annual ? "bg-purple-600" : "bg-slate-300"}`}
        >
          <span
            className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${annual ? "translate-x-4" : "translate-x-0"}`}
          />
        </button>
        Annual billing
      </label>

      <ul className="mb-8 flex-1 space-y-2.5 text-sm text-slate-600">
        {features.map((f) => (
          <li key={f} className="flex items-start gap-2">
            <span className="mt-0.5 text-purple-500">✓</span>
            {f}
          </li>
        ))}
      </ul>
      <Link href="/login?tab=signup" className="btn btn-primary w-full justify-center py-3">
        Start 14-day trial →
      </Link>
    </div>
  );
}
