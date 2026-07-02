import "server-only";
import type Stripe from "stripe";
import { getStripe } from "@/lib/stripe";

/**
 * Coupon management for the staff console. A customer-facing "coupon" is a
 * Stripe promotion code (the string they type) backed by a Stripe coupon (the
 * discount). Stripe coupons are immutable, so "editing" = deactivate + recreate;
 * promotion codes can only be toggled active/inactive.
 */

export interface CouponRow {
  promoId: string;
  couponId: string;
  code: string;
  active: boolean;
  discount: string; // "20% off" | "10.00 GBP off"
  duration: string; // "once" | "forever" | "3 months"
  redemptions: string; // "3" | "3 / 100"
  expiresAt: string | null;
  created: number;
}

function describeCoupon(c: Stripe.Coupon): { discount: string; duration: string } {
  const discount =
    c.percent_off != null
      ? `${c.percent_off}% off`
      : c.amount_off != null
        ? `${(c.amount_off / 100).toFixed(2)} ${(c.currency ?? "").toUpperCase()} off`
        : "—";
  const duration =
    c.duration === "repeating"
      ? `${c.duration_in_months ?? "?"} months`
      : c.duration; // once | forever
  return { discount, duration };
}

function toRow(p: Stripe.PromotionCode): CouponRow {
  const c = p.promotion.coupon;
  if (c == null || typeof c === "string") {
    // Only happens if the caller forgot to expand promotion.coupon.
    throw new Error("Promotion code was returned without an expanded coupon");
  }
  const { discount, duration } = describeCoupon(c);
  return {
    promoId: p.id,
    couponId: c.id,
    code: p.code,
    active: p.active,
    discount,
    duration,
    redemptions: p.max_redemptions
      ? `${p.times_redeemed} / ${p.max_redemptions}`
      : String(p.times_redeemed),
    expiresAt: p.expires_at ? new Date(p.expires_at * 1000).toISOString() : null,
    created: p.created,
  };
}

/** List the most recent promotion codes (with their coupon expanded). */
export async function listCoupons(): Promise<CouponRow[]> {
  const res = await getStripe().promotionCodes.list({
    limit: 100,
    expand: ["data.promotion.coupon"],
  });
  return res.data.map(toRow).sort((a, b) => b.created - a.created);
}

export interface CreateCouponInput {
  code: string;
  duration: "once" | "repeating" | "forever";
  durationInMonths?: number | null;
  percentOff?: number | null;
  amountOff?: number | null; // major units (e.g. dollars); converted to cents
  currency?: string | null;
  maxRedemptions?: number | null;
  expiresAt?: number | null; // unix seconds
}

/** Create a coupon + a promotion code that points at it. Returns the row. */
export async function createCoupon(input: CreateCouponInput): Promise<CouponRow> {
  const stripe = getStripe();

  const couponParams: Stripe.CouponCreateParams = {
    name: input.code,
    duration: input.duration,
  };
  if (input.duration === "repeating") {
    couponParams.duration_in_months = input.durationInMonths ?? 1;
  }
  if (input.percentOff != null) {
    couponParams.percent_off = input.percentOff;
  } else if (input.amountOff != null && input.currency) {
    couponParams.amount_off = Math.round(input.amountOff * 100);
    couponParams.currency = input.currency.toLowerCase();
  } else {
    throw new Error("Provide either a percent or an amount discount");
  }

  const coupon = await stripe.coupons.create(couponParams);

  const promoParams: Stripe.PromotionCodeCreateParams = {
    promotion: { type: "coupon", coupon: coupon.id },
    code: input.code,
    expand: ["promotion.coupon"],
  };
  if (input.maxRedemptions) promoParams.max_redemptions = input.maxRedemptions;
  if (input.expiresAt) promoParams.expires_at = input.expiresAt;

  const promo = await stripe.promotionCodes.create(promoParams);
  return toRow(promo);
}

/** Activate or deactivate a promotion code (coupons themselves are immutable). */
export async function setCouponActive(
  promoId: string,
  active: boolean,
): Promise<CouponRow> {
  const promo = await getStripe().promotionCodes.update(promoId, {
    active,
    expand: ["promotion.coupon"],
  });
  return toRow(promo);
}
