import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { getStripe } from "@/lib/stripe";
import { runEvent } from "@/server/usecases/billing-events";

// Signed Stripe webhook. The dispatch table lives in
// server/usecases/billing-events.ts, shared with the staff console's
// "process now" replay — this route only owns signature verification.
export async function POST(req: Request) {
  const rawBody = await req.text();
  const sig = req.headers.get("stripe-signature");
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!sig || !secret) {
    return NextResponse.json({ error: "Missing signature" }, { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(rawBody, sig, secret);
  } catch {
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  try {
    // runEvent claims the event atomically and processes it exactly once
    // (#229 P0-2); a duplicate or concurrent delivery is a no-op. It stamps
    // processed_at only after the handler ran, so a throw leaves the row
    // visible as "received" on /admin/billing-events for replay.
    await runEvent(event);
  } catch (err) {
    // Return 5xx so Stripe retries
    console.error("Webhook processing error:", err);
    return NextResponse.json({ error: "Processing failed" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
