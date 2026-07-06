import "server-only";
import { sql } from "@/lib/db";

export type ActivationEvent =
  | "signup"
  | "org_created"
  | "first_tournament_created"
  | "tournament_started"
  | "tournament_completed";

/**
 * Record a funnel milestone. Fire-and-forget — never throws; duplicate events
 * are silently ignored (unique constraint on user+org+event).
 */
export async function trackEvent(
  userId: string,
  orgId: string,
  event: ActivationEvent,
  meta?: Record<string, unknown>,
): Promise<void> {
  try {
    await sql`
      insert into activation_events (user_id, org_id, event, meta)
      values (${userId}, ${orgId}, ${event}, ${meta ? JSON.stringify(meta) : null})
      on conflict (user_id, org_id, event) do nothing`;
  } catch (err) {
    console.error("[activation] trackEvent failed:", err);
  }
}

/** Mark first-run wizard complete for this user. */
export async function markOnboardingDone(userId: string): Promise<void> {
  await sql`
    update users set onboarding_completed_at = now()
    where id = ${userId} and onboarding_completed_at is null`;
}

/** True if user has not yet completed the wizard. */
export async function needsOnboarding(userId: string): Promise<boolean> {
  const [row] = await sql<{ done: boolean }[]>`
    select onboarding_completed_at is not null as done
    from users where id = ${userId}`;
  return !row?.done;
}

/** Mark the product tour complete (or skipped) for this user. */
export async function markTourDone(userId: string): Promise<void> {
  await sql`
    update users set product_tour_completed_at = now()
    where id = ${userId} and product_tour_completed_at is null`;
}

/** Reset the tour so it auto-starts again on the dashboard (settings replay). */
export async function resetTour(userId: string): Promise<void> {
  await sql`
    update users set product_tour_completed_at = null
    where id = ${userId}`;
}

/** True if user has not yet completed the product tour. */
export async function needsTour(userId: string): Promise<boolean> {
  const [row] = await sql<{ done: boolean }[]>`
    select product_tour_completed_at is not null as done
    from users where id = ${userId}`;
  return !row?.done;
}
