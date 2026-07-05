"use client";

import Link from "next/link";
import { featureReason } from "@/lib/feature-copy";

interface Props {
  /** Entitlement feature key, e.g. "scoring.ball_by_ball" (doc 10 §1). */
  feature: string;
  /**
   * Where the paywall sends the user. Defaults to billing; pass a
   * plan-comparison anchor when the touchpoint has one.
   */
  href?: string;
  /** Compact renders a one-line pill (for toolbars/toggles); default is a card. */
  compact?: boolean;
}

/**
 * THE upgrade-moment component (doc 10 §3): one contextual paywall, rendered
 * exactly where a limit bites — adding a 2nd division, toggling ball-by-ball,
 * publishing a 2nd dashboard, enabling DLS, creating an API key. The copy
 * derives from the same feature_key the 402 response carries, so a blocked
 * server call and a pre-emptively gated control read identically.
 */
export function UpgradeGate({ feature, href = "/settings/billing", compact = false }: Props) {
  const reason = featureReason(feature);

  if (compact) {
    return (
      <Link
        href={href}
        data-feature={feature}
        className="inline-flex items-center gap-1.5 rounded-full bg-purple-50 px-3 py-1 text-xs font-medium text-purple-700 hover:bg-purple-100"
      >
        <LockIcon />
        {reason} <span className="font-semibold underline">Upgrade →</span>
      </Link>
    );
  }

  return (
    <div
      data-feature={feature}
      className="rounded-lg border border-purple-200 bg-purple-50 p-4 text-sm text-purple-900"
    >
      <p className="flex items-center gap-2 font-medium">
        <LockIcon />
        {reason}
      </p>
      <p className="mt-2">
        <Link href={href} className="font-semibold text-purple-700 underline">
          See plans & upgrade →
        </Link>
      </p>
    </div>
  );
}

function LockIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      fill="currentColor"
      className="h-3.5 w-3.5 shrink-0"
    >
      <path d="M8 1a3.5 3.5 0 0 0-3.5 3.5V6H4a1.5 1.5 0 0 0-1.5 1.5v5A1.5 1.5 0 0 0 4 14h8a1.5 1.5 0 0 0 1.5-1.5v-5A1.5 1.5 0 0 0 12 6h-.5V4.5A3.5 3.5 0 0 0 8 1Zm2 5H6V4.5a2 2 0 1 1 4 0V6Z" />
    </svg>
  );
}
