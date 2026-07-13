import { requireStaff, logStaffAction } from "@/lib/admin";
import { handler, HttpError } from "@/lib/http";
import { getStripe } from "@/lib/stripe";
import { replayEvent } from "@/server/usecases/billing-events";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/admin/billing-events/{id}/process — staff replay of a missed or
 *  stuck Stripe event. The event is re-fetched from Stripe by id (the API is
 *  the trust anchor, standing in for the webhook signature); the stored
 *  payload is never replayed. Handlers are idempotent, and replayEvent skips
 *  anything the ledger already saw through. Audited. */
export async function POST(_req: Request, { params }: Ctx) {
  return handler(async () => {
    const staff = await requireStaff();
    const { id } = await params;
    if (!/^evt_[A-Za-z0-9]+$/.test(id)) throw new HttpError(400, "Not a Stripe event id");
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new HttpError(503, "Stripe is not configured");
    }

    let event;
    try {
      event = await getStripe().events.retrieve(id);
    } catch {
      throw new HttpError(404, "Stripe doesn't know this event id");
    }

    const outcome = await replayEvent(event);
    await logStaffAction(staff.id, "billing_event_processed", "platform", id, {
      type: event.type,
      outcome,
    });
    return { id, type: event.type, outcome };
  });
}
