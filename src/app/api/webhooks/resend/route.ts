import { NextRequest, NextResponse } from "next/server";
import { suppress } from "@/lib/email";

// Resend signs webhooks with Svix — verify if RESEND_WEBHOOK_SECRET is set.
// Without it we accept but log a warning (safe for dev; lock down in prod).
async function verifySignature(req: NextRequest, body: string): Promise<boolean> {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    console.warn("[resend-webhook] RESEND_WEBHOOK_SECRET not set — skipping signature verify");
    return true;
  }

  // Svix headers
  const svixId = req.headers.get("svix-id");
  const svixTs = req.headers.get("svix-timestamp");
  const svixSig = req.headers.get("svix-signature");
  if (!svixId || !svixTs || !svixSig) return false;

  // Signed string: "<svix-id>.<svix-timestamp>.<body>"
  const signed = `${svixId}.${svixTs}.${body}`;
  const keyBytes = Uint8Array.from(
    atob(secret.replace(/^whsec_/, "")),
    (c) => c.charCodeAt(0),
  );
  const cryptoKey = await crypto.subtle.importKey(
    "raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(signed));
  const expected = "v1," + btoa(String.fromCharCode(...new Uint8Array(mac)));

  // Resend may send multiple sigs; any match passes
  return svixSig.split(" ").some((s) => s === expected);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = await req.text();

  const valid = await verifySignature(req, body);
  if (!valid) return NextResponse.json({ error: "invalid signature" }, { status: 401 });

  let event: { type?: string; data?: Record<string, unknown> };
  try {
    event = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const type = event.type ?? "";
  const data = event.data ?? {};

  if (type === "email.bounced") {
    const email = (data.to as string[] | undefined)?.[0] ?? (data.email as string | undefined);
    const id = data.email_id as string | undefined;
    if (email) {
      await suppress(email, "bounce", id).catch((e) =>
        console.error("[resend-webhook] suppress bounce failed:", e),
      );
      console.info(`[resend-webhook] bounce suppressed: ${email}`);
    }
  } else if (type === "email.complained") {
    const email = (data.to as string[] | undefined)?.[0] ?? (data.email as string | undefined);
    const id = data.email_id as string | undefined;
    if (email) {
      await suppress(email, "complaint", id).catch((e) =>
        console.error("[resend-webhook] suppress complaint failed:", e),
      );
      console.info(`[resend-webhook] complaint suppressed: ${email}`);
    }
  }
  // Ignore other event types (email.sent, email.opened, etc.)

  return NextResponse.json({ ok: true });
}
