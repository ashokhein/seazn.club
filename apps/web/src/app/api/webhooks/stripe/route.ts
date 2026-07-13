import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { getStripe } from "@/lib/stripe";
import { sql } from "@/lib/db";
import { runEvent } from "@/server/usecases/billing-events";

// Signed Stripe webhook. The dispatch table lives in
// server/usecases/billing-events.ts, shared with the staff console's
// "process now" replay — this route only owns signature verification and
// the already-processed fast path.
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

  // Idempotency: skip if already recorded (processed or mid-flight).
  const [existing] = await sql<{ id: string }[]>`
    select id from billing_events where id = ${event.id}`;
  if (existing) return NextResponse.json({ received: true });

  try {
    // Records the row first, stamps processed_at only after the handler ran —
    // a throw leaves it visible as "received" on /admin/billing-events.
    await runEvent(event);
  } catch (err) {
    // Return 5xx so Stripe retries
    console.error("Webhook processing error:", err);
    return NextResponse.json({ error: "Processing failed" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
