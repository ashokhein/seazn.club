import { loadStripe } from "@stripe/stripe-js";

/** Load Stripe.js once for the whole app (publishable key is public). Shared
 *  by embedded checkout and the in-app billing manage surface (v3/11). */
export const stripePromise = loadStripe(
  process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? "",
);

/** Elements appearance matched to the app's form system (.input / btn-primary):
 *  purple focus ring, rounded-lg, slate text. */
export const stripeAppearance = {
  variables: {
    colorPrimary: "#9333ea",
    colorText: "#1e293b",
    colorDanger: "#ef4444",
    borderRadius: "8px",
    fontSizeBase: "14px",
  },
} as const;
