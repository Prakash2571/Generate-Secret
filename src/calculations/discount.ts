import { config } from '../config';
import type { DiscountBreakdown, OfferTerms, TargetAnalysis } from '../types';

/** The subset of coupon fields the maths needs (works for candidates and documents). */
export type CouponLike = Pick<
  OfferTerms,
  | 'discountType'
  | 'discountValue'
  | 'minimumOrder'
  | 'maximumDiscount'
  | 'isUpTo'
  | 'minimumOrderKnown'
>;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Discount this coupon would produce on `cartValue`.
 *
 * Deliberately conservative:
 *  - "up to X% off" yields no guaranteed discount (X is an upper bound)
 *  - store-wide sales are not cart discounts
 *  - cashback does not reduce the amount payable at checkout
 *  - a cart below a *known* minimum order yields nothing
 *  - a flat discount with an *unpublished* minimum order is computed
 *    optimistically but flagged as an assumption by `analyzeCoupon`
 */
export function calculateDiscount(coupon: CouponLike, cartValue: number): DiscountBreakdown {
  const base: DiscountBreakdown = {
    cartValue,
    discount: 0,
    finalPrice: round2(cartValue),
    effectiveDiscount: 0,
    applicable: false,
  };

  if (!(cartValue > 0)) {
    return { ...base, reason: 'cart value must be positive' };
  }

  if (coupon.minimumOrderKnown && coupon.minimumOrder !== undefined && cartValue < coupon.minimumOrder) {
    return {
      ...base,
      reason: `cart below published minimum order of ${coupon.minimumOrder}`,
    };
  }

  if (coupon.isUpTo) {
    return {
      ...base,
      reason: 'advertised as "up to" - no guaranteed discount for a specific cart',
    };
  }

  let discount: number;
  switch (coupon.discountType) {
    case 'flat': {
      if (coupon.discountValue === undefined) {
        return { ...base, reason: 'flat discount value unknown' };
      }
      discount = coupon.discountValue;
      break;
    }
    case 'percentage': {
      if (coupon.discountValue === undefined) {
        return { ...base, reason: 'percentage value unknown' };
      }
      discount = (cartValue * coupon.discountValue) / 100;
      break;
    }
    case 'sale': {
      return {
        ...base,
        reason: 'store-wide sale, not a cart-level coupon discount',
      };
    }
    case 'cashback': {
      return {
        ...base,
        reason: 'cashback is paid after purchase and does not reduce the amount payable',
      };
    }
    case 'unknown':
    default: {
      return { ...base, reason: 'offer terms could not be parsed' };
    }
  }

  if (coupon.maximumDiscount !== undefined) {
    discount = Math.min(discount, coupon.maximumDiscount);
  }
  // Never claim a discount larger than the cart itself.
  discount = Math.max(0, Math.min(discount, cartValue));

  const finalPrice = cartValue - discount;
  return {
    cartValue,
    discount: round2(discount),
    finalPrice: round2(finalPrice),
    effectiveDiscount: round2(discount / cartValue),
    applicable: discount > 0,
  };
}

export function calculateFinalPrice(coupon: CouponLike, cartValue: number): number {
  return calculateDiscount(coupon, cartValue).finalPrice;
}

/**
 * Full ladder analysis plus the target verdict.
 *
 * TARGET_MATCH is only awarded when the coupon provably reaches the target
 * (>= TARGET_DISCOUNT off, <= cart-target remaining) with *published* terms.
 * When an assumption was required the result is a `potentialTargetMatch`.
 */
export function analyzeCoupon(
  coupon: CouponLike,
  options: { targetCartValue?: number; targetDiscount?: number; ladder?: number[] } = {},
): TargetAnalysis {
  const targetCartValue = options.targetCartValue ?? config.targetCartValue;
  const targetDiscount = options.targetDiscount ?? config.targetDiscount;
  const ladder = options.ladder ?? config.cartValueLadder;

  const cartValues = ladder.includes(targetCartValue) ? ladder : [...ladder, targetCartValue];
  const breakdowns = cartValues
    .slice()
    .sort((a, b) => a - b)
    .map((cartValue) => calculateDiscount(coupon, cartValue));

  const atTarget =
    breakdowns.find((entry) => entry.cartValue === targetCartValue) ??
    calculateDiscount(coupon, targetCartValue);

  const uncertaintyReason = describeUncertainty(coupon);
  const uncertain = uncertaintyReason !== undefined;

  const maxFinalPrice = targetCartValue - targetDiscount;
  const hitsTarget = atTarget.discount >= targetDiscount && atTarget.finalPrice <= maxFinalPrice;

  return {
    breakdowns,
    targetCartValue,
    discountAtTarget: atTarget.discount,
    finalPriceAtTarget: atTarget.finalPrice,
    effectiveDiscountAtTarget: atTarget.effectiveDiscount,
    targetMatch: hitsTarget && !uncertain,
    potentialTargetMatch: hitsTarget && uncertain,
    uncertain,
    uncertaintyReason,
  };
}

/** Returns why the numbers cannot be fully trusted, or undefined if they can. */
export function describeUncertainty(coupon: CouponLike): string | undefined {
  if (coupon.isUpTo) return 'advertised as "up to" - guaranteed value unknown';
  if (coupon.discountType === 'sale') return 'store-wide sale rather than a cart coupon';
  if (coupon.discountType === 'unknown') return 'offer terms could not be parsed';
  if (coupon.discountType === 'cashback') return 'cashback, not a checkout discount';
  if (coupon.discountValue === undefined) return 'discount value not published';
  if (!coupon.minimumOrderKnown) return 'minimum order not published - applicability assumed';
  if (coupon.discountType === 'percentage' && coupon.maximumDiscount === undefined) {
    return 'percentage offer without a published cap';
  }
  return undefined;
}

/** Short human label for tables and reports, e.g. "₹800 OFF" / "UP TO 80% OFF". */
export function formatOffer(coupon: CouponLike): string {
  const prefix = coupon.isUpTo ? 'UP TO ' : '';
  switch (coupon.discountType) {
    case 'flat':
      return coupon.discountValue !== undefined
        ? `${prefix}\u20b9${formatAmount(coupon.discountValue)} OFF`
        : 'FLAT OFF (value unknown)';
    case 'percentage':
      return coupon.discountValue !== undefined
        ? `${prefix}${trimNumber(coupon.discountValue)}% OFF`
        : 'PERCENT OFF (value unknown)';
    case 'sale':
      return coupon.discountValue !== undefined
        ? `${prefix}${trimNumber(coupon.discountValue)}% SALE`
        : 'SALE';
    case 'cashback':
      return coupon.discountValue !== undefined
        ? `${prefix}\u20b9${formatAmount(coupon.discountValue)} CASHBACK`
        : 'CASHBACK';
    case 'unknown':
    default:
      return 'UNKNOWN OFFER';
  }
}

export function formatAmount(value: number): string {
  return Number.isInteger(value) ? value.toLocaleString('en-IN') : value.toFixed(2);
}

export function formatRupees(value: number | undefined | null): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return '-';
  return `\u20b9${formatAmount(value)}`;
}

function trimNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
