import { formatOffer, formatRupees } from '../calculations/discount';
import { config } from '../config';
import { applyValidationOutcome, findCouponsNeedingValidation } from '../db/couponRepository';
import type { CouponDocument } from '../db/models/Coupon';
import type { CouponStatus } from '../types';
import { describeError, logger } from '../utils/logger';
import { validateCoupon } from '../validators/couponValidator';
import { humanDuration } from '../utils/time';

export interface ValidationStats {
  startedAt: Date;
  durationMs: number;
  attempted: number;
  results: Record<CouponStatus, number>;
  cartValidationsUsed: number;
  errors: number;
}

const EMPTY_RESULTS = (): Record<CouponStatus, number> => ({
  valid: 0,
  invalid: 0,
  expired: 0,
  unverified: 0,
  manual_validation_required: 0,
});

/** Log marker per status, so the console reads like the specification examples. */
const STATUS_TAG: Record<CouponStatus, string> = {
  valid: 'VALID',
  invalid: 'INVALID',
  expired: 'EXPIRED',
  unverified: 'UNVERIFIED',
  manual_validation_required: 'MANUAL',
};

/**
 * Revalidates coupons whose validity information has gone stale.
 *
 * Runs sequentially: validation can involve a real browser session, and being
 * gentle with SHEIN matters more than finishing quickly. The cart-validation
 * budget is shared across the whole cycle.
 */
export async function runValidation(signal: AbortSignal): Promise<ValidationStats> {
  const startedAt = new Date();
  const started = Date.now();
  const results = EMPTY_RESULTS();
  let errors = 0;

  const cartBudget = { remaining: config.maxCartValidationsPerCycle };

  let queue: CouponDocument[] = [];
  try {
    queue = await findCouponsNeedingValidation(config.maxValidationsPerCycle, startedAt);
  } catch (error) {
    logger.error('failed to load validation queue', { reason: describeError(error) });
    return {
      startedAt,
      durationMs: Date.now() - started,
      attempted: 0,
      results,
      cartValidationsUsed: 0,
      errors: 1,
    };
  }

  logger.tag('INFO', 'Validation started', {
    queued: queue.length,
    cartBudget: cartBudget.remaining,
  });

  let attempted = 0;

  for (const coupon of queue) {
    if (signal.aborted) {
      logger.info('validation interrupted by shutdown', { done: attempted, of: queue.length });
      break;
    }

    attempted += 1;
    try {
      const outcome = await validateCoupon(coupon, {
        signal,
        now: new Date(),
        cartBudget,
      });

      await applyValidationOutcome(coupon, outcome, new Date());
      results[outcome.status] += 1;

      logger.tag(STATUS_TAG[outcome.status], describeCoupon(coupon), {
        method: outcome.method,
        confidence: coupon.confidence,
        note: outcome.notes.slice(0, 160),
      });
    } catch (error) {
      errors += 1;
      logger.error('validation failed', {
        code: coupon.code,
        reason: describeError(error),
      });
    }
  }

  const durationMs = Date.now() - started;
  logger.tag('INFO', 'Validation finished', {
    attempted,
    valid: results.valid,
    invalid: results.invalid,
    expired: results.expired,
    unverified: results.unverified,
    manual: results.manual_validation_required,
    took: humanDuration(durationMs),
  });

  return {
    startedAt,
    durationMs,
    attempted,
    results,
    cartValidationsUsed: config.maxCartValidationsPerCycle - cartBudget.remaining,
    errors,
  };
}

function describeCoupon(coupon: CouponDocument): string {
  const label = coupon.code ?? coupon.title ?? 'untitled offer';
  const offer = formatOffer(coupon);
  const minimum =
    coupon.minimumOrderKnown && coupon.minimumOrder !== undefined
      ? ` (min ${formatRupees(coupon.minimumOrder)})`
      : '';
  return `${label} \u2014 ${offer}${minimum}`;
}
