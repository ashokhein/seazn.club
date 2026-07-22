// A local stand-in for the Stripe REST API, so e2e can drive the LIVE-group
// money paths — a charged attach, a card handover, a proration preview —
// without touching a real Stripe account. The app's Stripe client is pointed
// here by STRIPE_MOCK_HOST/PORT (see lib/stripe.ts), the same trick
// ai-fixture-server.ts uses for the model endpoint.
//
// It is deliberately a HAND-WRITTEN fixture, not stripe-mock: the e2e assertions
// need to pin exact outcomes (was a proration raised? what amount? which payment
// method became default?), which means the responses have to be under this
// file's control, not a generic spec dump.
//
// What it does NOT prove: Stripe's real graduated-tier arithmetic. The amounts
// here are the ones this file returns. Only a real test-mode account settles
// whether Stripe bills a second seat at half rate — see the walkthrough's gaps.
import { createServer, type Server, type IncomingMessage } from "node:http";

export const STRIPE_FIXTURE_PORT = 12111;

interface SubItem {
  id: string;
  quantity: number;
  price: { id: string; billing_scheme: "tiered" | "per_unit"; unit_amount: number | null };
}
interface SubState {
  id: string;
  customer: string;
  status: string;
  currency: string;
  items: SubItem[];
}

export interface StripeFixtureCall {
  method: string;
  path: string;
  body: Record<string, unknown>;
}

export interface StripeFixtureServer {
  url: string;
  host: string;
  port: number;
  calls: StripeFixtureCall[];
  /** Register a live subscription the app will retrieve/update. */
  seedSubscription(sub: {
    id: string;
    customer: string;
    itemId?: string;
    quantity?: number;
    priceId?: string;
    scheme?: "tiered" | "per_unit";
    unitAmount?: number;
    currency?: string;
    status?: string;
  }): void;
  /** The proration total (minor units) the NEXT invoice preview returns. */
  setUpcomingProration(amountMinor: number, currency?: string): void;
  reset(): void;
  close(): Promise<void>;
}

// x-www-form-urlencoded is how the Stripe SDK sends bodies; flatten the common
// shapes the app posts (items[0][quantity], proration_behavior, …).
function parseForm(raw: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const pair of raw.split("&")) {
    if (!pair) continue;
    const [k, v] = pair.split("=").map((s) => decodeURIComponent(s.replace(/\+/g, " ")));
    out[k] = v;
  }
  return out;
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => resolve(raw));
  });
}

function subJson(s: SubState) {
  return {
    id: s.id,
    object: "subscription",
    status: s.status,
    customer: s.customer,
    currency: s.currency,
    items: {
      object: "list",
      data: s.items.map((it) => ({
        id: it.id,
        object: "subscription_item",
        quantity: it.quantity,
        price: {
          id: it.price.id,
          object: "price",
          billing_scheme: it.price.billing_scheme,
          unit_amount: it.price.unit_amount,
          currency: s.currency,
        },
      })),
    },
  };
}

export async function startStripeFixtureServer(
  port = STRIPE_FIXTURE_PORT,
): Promise<StripeFixtureServer> {
  const subs = new Map<string, SubState>();
  const calls: StripeFixtureCall[] = [];
  let upcoming = { amount: 0, currency: "usd" };

  const server: Server = createServer((req, res) => {
    void (async () => {
      const raw = await readBody(req);
      const body = raw ? parseForm(raw) : {};
      const method = req.method ?? "GET";
      const path = (req.url ?? "").split("?")[0];
      calls.push({ method, path, body });
      const send = (obj: unknown, code = 200) =>
        res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(obj));

      // GET/POST /v1/subscriptions/{id}
      const subMatch = /^\/v1\/subscriptions\/(sub_[A-Za-z0-9_]+)$/.exec(path);
      if (subMatch) {
        const s = subs.get(subMatch[1]);
        if (!s) return send({ error: { message: "no such subscription" } }, 404);
        if (method === "POST") {
          // items[0][id]=si_x&items[0][quantity]=2&proration_behavior=create_prorations
          const q = body["items[0][quantity]"];
          if (q !== undefined && s.items[0]) s.items[0].quantity = Number(q);
        }
        return send(subJson(s));
      }

      // POST /v1/invoices (createPreview) or GET upcoming — the proration preview.
      if (path === "/v1/invoices/create_preview" || path.startsWith("/v1/invoices/upcoming")) {
        return send({
          object: "invoice",
          currency: upcoming.currency,
          amount_due: upcoming.amount,
          total: upcoming.amount,
          lines: {
            object: "list",
            data: [
              { object: "line_item", amount: upcoming.amount, proration: true, currency: upcoming.currency },
            ],
          },
        });
      }

      // POST /v1/setup_intents — the card-handover offer.
      if (path === "/v1/setup_intents" && method === "POST") {
        const id = "seti_fix_" + Math.random().toString(36).slice(2, 10);
        return send({
          id,
          object: "setup_intent",
          status: "requires_payment_method",
          client_secret: id + "_secret_fix",
          customer: body.customer ?? null,
        });
      }
      const seti = /^\/v1\/setup_intents\/(seti_[A-Za-z0-9_]+)$/.exec(path);
      if (seti) {
        return send({
          id: seti[1],
          object: "setup_intent",
          status: "succeeded",
          payment_method: "pm_fix_confirmed",
          customer: "cus_fixture",
        });
      }

      // Customer payment methods + default (handover sweep + accept).
      const pm = /^\/v1\/customers\/(cus_[A-Za-z0-9_]+)\/payment_methods$/.exec(path);
      if (pm) {
        return send({
          object: "list",
          data: [{ id: "pm_fix_confirmed", object: "payment_method", type: "card", customer: pm[1] }],
        });
      }
      if (/^\/v1\/customers\/cus_[A-Za-z0-9_]+$/.exec(path) && method === "POST") {
        return send({ id: path.split("/").pop(), object: "customer" });
      }
      if (/^\/v1\/payment_methods\/pm_[A-Za-z0-9_]+\/attach$/.exec(path)) {
        return send({ id: "pm_fix_confirmed", object: "payment_method" });
      }

      // Everything else: an empty-but-valid object, so an unexpected call fails
      // an assertion loudly rather than crashing the SDK.
      return send({ object: "unknown", id: "fix_unhandled" });
    })();
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${port}`,
    host: "127.0.0.1",
    port,
    calls,
    seedSubscription(sub) {
      subs.set(sub.id, {
        id: sub.id,
        customer: sub.customer,
        status: sub.status ?? "active",
        currency: sub.currency ?? "usd",
        items: [
          {
            id: sub.itemId ?? "si_fix_" + sub.id.slice(4, 10),
            quantity: sub.quantity ?? 1,
            price: {
              id: sub.priceId ?? "price_fix_pro",
              billing_scheme: sub.scheme ?? "tiered",
              unit_amount: sub.unitAmount ?? null,
            },
          },
        ],
      });
    },
    setUpcomingProration(amountMinor, currency = "usd") {
      upcoming = { amount: amountMinor, currency };
    },
    reset() {
      subs.clear();
      calls.length = 0;
      upcoming = { amount: 0, currency: "usd" };
    },
    close() {
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
