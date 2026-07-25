import { z } from "zod";
import { handler } from "@/lib/http";
import { setExtraSeats } from "@/server/usecases/extra-seats";

const schema = z.object({ seats: z.number().int().min(0).max(999) }).strict();

/**
 * POST /api/billing/extra-seats — add / adjust / remove the recurring
 * extra-seat add-on ($4/seat/month, +1 members.max each) for the caller's
 * ACTIVE org (v17 SPEC-2 §3/§11.3, Phase 3 Task 3a).
 *
 * Group-payer gated inside setExtraSeats (requireBillingOwner) — a non-payer
 * gets 403 before any Stripe call. The seat rides the group's existing
 * subscription as an extra item; the org_addons row is written by the
 * customer.subscription.updated webhook, never here.
 */
export async function POST(req: Request) {
  return handler(async () => {
    const { seats } = schema.parse(await req.json());
    return setExtraSeats(seats);
  });
}
