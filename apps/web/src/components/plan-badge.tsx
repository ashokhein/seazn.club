// Tiny plan pill shown on any gated button/panel so users see the required
// tier before they click (doc 10 §3). Server- and client-safe (no hooks).
//
// v3/03 §6 plan scrub: `business` survives only as a hidden DB plan key
// (grandfathering / enterprise deals) — the UI never names it. Features that
// sit above Pro render the generic "Upgrade" pill; everything else says Pro.
import { featurePlan, type PaidPlan } from "@/lib/feature-copy";

const STYLE: Record<PaidPlan, string> = {
  pro: "bg-purple-100 text-purple-700",
  business: "bg-indigo-100 text-indigo-700",
};

const LABEL: Record<PaidPlan, string> = {
  pro: "Pro ✦",
  business: "Upgrade ◆",
};

export function PlanBadge({ plan, feature }: { plan?: PaidPlan; feature?: string }) {
  const p = plan ?? featurePlan(feature ?? "");
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${STYLE[p]}`}
    >
      {LABEL[p]}
    </span>
  );
}
