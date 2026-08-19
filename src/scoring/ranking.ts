import { analyzeCoupon } from '../calculations/discount';
import type { ICoupon } from '../db/models/Coupon';
import type { CouponStatus, TargetAnalysis } from '../types';
import { countIndependentSources } from './confidence';

/** Lower is better. Validity dominates every other ranking signal. */
const STATUS_RANK: Record<CouponStatus, number> = {
  valid: 0,
  manual_validation_required: 1,
  unverified: 2,
  invalid: 3,
  expired: 4,
};

export interface RankedCoupon {
  coupon: ICoupon;
  analysis: TargetAnalysis;
  independentSources: number;
  /** True when the coupon provably delivers the target discount. */
  targetMatch: boolean;
}

export function decorate(coupon: ICoupon, now: Date = new Date()): RankedCoupon {
  const analysis = analyzeCoupon(coupon);
  return {
    coupon,
    analysis,
    independentSources: countIndependentSources(coupon.sources, now),
    targetMatch: analysis.targetMatch,
  };
}

/**
 * Ranking order (specification section 16):
 *   1. validity
 *   2. lowest final payable price on the target cart value
 *   3. highest effective discount
 *   4. confidence
 *   5. freshness
 *   6. number of independent sources
 *
 * Never the advertised percentage: "80% off, max ₹300" loses to "₹600 off ₹1000"
 * on a ₹1000 cart because the payable price is what actually matters.
 */
export function compareRanked(a: RankedCoupon, b: RankedCoupon): number {
  const statusDelta = STATUS_RANK[a.coupon.status] - STATUS_RANK[b.coupon.status];
  if (statusDelta !== 0) return statusDelta;

  // A coupon that cannot be applied at the target value has no payable price.
  const priceA = payableOrInfinity(a);
  const priceB = payableOrInfinity(b);
  if (priceA !== priceB) return priceA - priceB;

  const effectiveDelta = b.analysis.effectiveDiscountAtTarget - a.analysis.effectiveDiscountAtTarget;
  if (Math.abs(effectiveDelta) > 1e-9) return effectiveDelta;

  // Provable beats assumed when the numbers are otherwise identical.
  if (a.targetMatch !== b.targetMatch) return a.targetMatch ? -1 : 1;
  if (a.analysis.uncertain !== b.analysis.uncertain) return a.analysis.uncertain ? 1 : -1;

  const confidenceDelta = b.coupon.confidence - a.coupon.confidence;
  if (confidenceDelta !== 0) return confidenceDelta;

  const freshnessDelta = timeOf(b.coupon.lastSeenAt) - timeOf(a.coupon.lastSeenAt);
  if (freshnessDelta !== 0) return freshnessDelta;

  const sourceDelta = b.independentSources - a.independentSources;
  if (sourceDelta !== 0) return sourceDelta;

  return (a.coupon.code ?? a.coupon.title ?? '').localeCompare(b.coupon.code ?? b.coupon.title ?? '');
}

function payableOrInfinity(entry: RankedCoupon): number {
  const breakdown = entry.analysis.breakdowns.find(
    (item) => item.cartValue === entry.analysis.targetCartValue,
  );
  if (!breakdown || !breakdown.applicable) return Number.POSITIVE_INFINITY;
  return breakdown.finalPrice;
}

function timeOf(date: Date | undefined): number {
  return date ? date.getTime() : 0;
}

export function rankCoupons(coupons: readonly ICoupon[], now: Date = new Date()): RankedCoupon[] {
  return coupons.map((coupon) => decorate(coupon, now)).sort(compareRanked);
}

/** Best coupon overall, restricted to a status group when asked. */
export function pickBest(
  ranked: readonly RankedCoupon[],
  statuses?: readonly CouponStatus[],
): RankedCoupon | undefined {
  const pool = statuses ? ranked.filter((entry) => statuses.includes(entry.coupon.status)) : ranked;
  return pool[0];
}
