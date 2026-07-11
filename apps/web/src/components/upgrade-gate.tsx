"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { featureReason } from "@/lib/feature-copy";
import { PlanBadge } from "@/components/plan-badge";
import { formatMinor, passPrice, proPrice } from "@/lib/currency";
import { routes } from "@/lib/routes";

/** Features an Event Pass lifts (mirror of the event_pass plan_entitlements
 *  column, v3/07 §2) — only these gates offer the per-event path. */
const PASS_FEATURES = new Set([
  "divisions.per_competition.max",
  "entrants.per_division.max",
  "formats.advanced",
  "formats.double_elim",
  "registration.paid",
  "branding",
  "exports",
  "realtime",
]);

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

/** The competition upgrade URL when the gate renders inside a competition. */
function passHrefFromPath(pathname: string | null): string | null {
  const m = pathname?.match(/^\/o\/([^/]+)\/c\/([^/]+)(?:\/|$)/);
  if (!m || m[2] === "new") return null;
  return routes.competitionUpgrade(m[1], m[2]);
}

/**
 * THE upgrade-moment component (doc 10 §3): one contextual paywall, rendered
 * exactly where a limit bites — adding a division, toggling ball-by-ball,
 * publishing a 2nd dashboard, enabling DLS, creating an API key. The copy
 * derives from the same feature_key the 402 response carries, so a blocked
 * server call and a pre-emptively gated control read identically.
 *
 * Inside a competition, pass-liftable gates offer BOTH paths (v3/07 §3):
 * a one-time Event Pass for this competition, or Pro for the whole org.
 */
export function UpgradeGate({ feature, href = "/settings/billing", compact = false }: Props) {
  const reason = featureReason(feature);
  const pathname = usePathname();
  const passHref = PASS_FEATURES.has(feature) ? passHrefFromPath(pathname) : null;

  if (compact) {
    return (
      <Link
        href={passHref ?? href}
        data-feature={feature}
        className="inline-flex items-center gap-1.5 rounded-full bg-purple-50 px-3 py-1 text-xs font-medium text-purple-700 hover:bg-purple-100"
      >
        <LockIcon />
        <PlanBadge feature={feature} />
        {reason} <span className="font-semibold underline">Upgrade →</span>
      </Link>
    );
  }

  if (passHref) {
    const passLabel = `${formatMinor(passPrice("usd"), "usd")} one-time`;
    const proLabel = `${formatMinor(proPrice("monthly", "usd"), "usd")}/mo`;
    return (
      <div
        data-feature={feature}
        data-pass-gate
        className="rounded-lg border border-purple-200 bg-purple-50 p-4 text-sm text-purple-900"
      >
        <p className="flex items-center gap-2 font-medium">
          <LockIcon />
          <PlanBadge feature={feature} />
          {reason}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Link
            href={passHref}
            className="btn btn-primary px-4 py-2 text-sm"
            data-pass-cta
          >
            Upgrade this event — {passLabel}
          </Link>
          <Link href={href} className="btn btn-ghost px-4 py-2 text-sm">
            Go Pro — {proLabel}
          </Link>
        </div>
        <p className="mt-2 text-xs text-purple-700">
          The Event Pass upgrades this competition for its lifetime. Pro covers
          every competition in your organization.
        </p>
      </div>
    );
  }

  return (
    <div
      data-feature={feature}
      className="rounded-lg border border-purple-200 bg-purple-50 p-4 text-sm text-purple-900"
    >
      <p className="flex items-center gap-2 font-medium">
        <LockIcon />
        <PlanBadge feature={feature} />
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
