import Link from "@/components/ui/console-link";
import { sql } from "@/lib/db";
import type { Subscription } from "@/lib/types";

interface Props {
  orgId: string;
}

function daysUntil(iso: string | null): number | null {
  if (!iso) return null;
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
}

/**
 * Shows trial countdown, past-due, or suspended banners.
 * Renders nothing when the subscription is healthy or on community plan.
 */
export async function BillingBanner({ orgId }: Props) {
  // has_payment_method is a local MIRROR of Stripe (V304) precisely so this can
  // stay a single indexed read: the banner renders on org home, a hot path, and
  // a live Stripe call per page view is not acceptable.
  const [sub] = await sql<
    Pick<Subscription, "plan_key" | "status" | "trial_end" | "has_payment_method">[]
  >`
    select plan_key, status, trial_end, has_payment_method
    from subscriptions where org_id = ${orgId}`;

  if (!sub || sub.status === "active" || sub.plan_key === "community") return null;

  if (sub.status === "trialing") {
    const days = daysUntil(sub.trial_end);
    if (days === null) return null;
    // The COUNTDOWN is never conditional — only the ask. An org that has
    // already added a card was still being told to add one (report
    // 2026-07-20), which read as the payment having failed.
    const askForCard = !sub.has_payment_method;
    if (days > 7) {
      return (
        <div className="bg-purple-50 px-4 py-2 text-center text-sm text-purple-700">
          {days} days left on your Pro trial.{" "}
          {askForCard && (
            <Link href="/settings/billing" className="font-semibold underline">
              Add a card to keep Pro →
            </Link>
          )}
        </div>
      );
    }
    return (
      <div className="bg-purple-600 px-4 py-2 text-center text-sm text-white">
        {days <= 0
          ? "Your Pro trial has ended. "
          : `${days} day${days === 1 ? "" : "s"} left in your Pro trial. `}
        {askForCard && (
          <Link href="/settings/billing" className="font-semibold underline">
            Add a payment method →
          </Link>
        )}
      </div>
    );
  }

  if (sub.status === "past_due") {
    return (
      <div className="bg-amber-500 px-4 py-2 text-center text-sm text-white">
        Payment failed — your subscription is past due.{" "}
        <Link href="/settings/billing" className="font-semibold underline">
          Update payment →
        </Link>
      </div>
    );
  }

  if (sub.status === "suspended") {
    return (
      <div className="bg-red-600 px-4 py-2 text-center text-sm text-white">
        Your account is suspended due to a failed payment. Data is preserved.{" "}
        <Link href="/settings/billing" className="font-semibold underline">
          Reactivate →
        </Link>
      </div>
    );
  }

  return null;
}
