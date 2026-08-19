import { config } from '../config';
import type { CouponSourceEntry, ICoupon } from '../db/models/Coupon';
import { countIndependentSources, normaliseDomain } from '../scoring/confidence';
import type { ValidationOutcome } from '../types';
import { describeError, logger } from '../utils/logger';
import { hoursSince } from '../utils/time';
import { validateInCart } from './cartValidator';

export interface ValidationContext {
  signal: AbortSignal;
  now: Date;
  /** Shared, mutable budget so one cycle cannot flood SHEIN with requests. */
  cartBudget: { remaining: number };
}

/** Official publication is only "current" evidence for this long. */
const OFFICIAL_FRESH_HOURS = 48;

/**
 * Evidence cascade (specification section 13):
 *
 *   published expiry
 *        v
 *   current official SHEIN publication
 *        v
 *   normal cart coupon field
 *        v
 *   trusted recent third-party sources  -> never enough for `valid`
 *
 * The function is deliberately reluctant: `valid` requires either an official
 * current publication or an actual acceptance by the coupon field. Ten affiliate
 * sites repeating each other produce `unverified`, by design.
 */
export async function validateCoupon(
  coupon: ICoupon,
  context: ValidationContext,
): Promise<ValidationOutcome> {
  const label = coupon.code ?? coupon.title ?? 'untitled offer';
  logger.tag('VALIDATE', label, {
    status: coupon.status,
    sources: coupon.sourceCount,
  });

  // --- 1. Published expiry ------------------------------------------------
  if (coupon.expiryDate && coupon.expiryDate.getTime() < context.now.getTime()) {
    return {
      status: 'expired',
      method: 'expiry-date',
      notes: `published expiry ${coupon.expiryDate.toISOString()} has passed`,
    };
  }

  // --- 2. Current official publication ------------------------------------
  const official = freshestOfficialSource(coupon.sources, context.now);
  if (official) {
    return {
      status: 'valid',
      method: 'official-publication',
      notes:
        `still published on an official SHEIN India page ` +
        `(${official.url}, last seen ${official.lastSeenAt.toISOString()})`,
    };
  }

  // --- 3. Normal cart coupon field ---------------------------------------
  if (coupon.code && config.enableCartValidation && context.cartBudget.remaining > 0) {
    context.cartBudget.remaining -= 1;
    try {
      const result = await validateInCart(coupon.code, { signal: context.signal });
      logger.debug('cart validation result', {
        code: coupon.code,
        verdict: result.verdict,
        detail: result.detail,
      });

      switch (result.verdict) {
        case 'accepted':
          return {
            status: 'valid',
            method: 'cart-coupon-field',
            notes: result.detail,
            acceptedByCart: true,
            observedTerms: result.observedTerms,
          };
        case 'rejected':
          return {
            status: 'invalid',
            method: 'cart-coupon-field',
            notes: result.detail,
          };
        case 'conditional':
          return {
            status: 'manual_validation_required',
            method: 'cart-coupon-field',
            notes: `${result.detail} - a qualifying cart is required to confirm`,
            observedTerms: result.observedTerms,
          };
        case 'blocked':
          return {
            status: 'manual_validation_required',
            method: 'cart-coupon-field',
            notes: `${result.detail}; validation stops here by policy`,
          };
        case 'unavailable':
        default:
          break;
      }
    } catch (error) {
      logger.warn('cart validation error', {
        code: coupon.code,
        reason: describeError(error),
      });
    }
  }

  // --- 4. Expiry reported by publishers ----------------------------------
  const expiredReport = assessExpiredReports(coupon.sources, context.now);
  if (expiredReport.reliable) {
    return {
      status: 'invalid',
      method: 'source-expiry-reports',
      notes: expiredReport.detail,
    };
  }

  // --- 5. Third-party claims only ---------------------------------------
  const independent = countIndependentSources(coupon.sources, context.now);
  const notes = buildUnverifiedNote(coupon, independent, expiredReport.detail);

  return {
    status: 'unverified',
    method: 'public-sources-only',
    notes,
  };
}

/** Most recent official source, if it is still within the freshness window. */
export function freshestOfficialSource(
  sources: readonly CouponSourceEntry[],
  now: Date,
): CouponSourceEntry | undefined {
  const officialSources = sources
    .filter((source) => source.type === 'official')
    .filter((source) => !source.reportedExpired)
    .filter((source) => hoursSince(source.lastSeenAt, now) <= OFFICIAL_FRESH_HOURS)
    .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime());

  return officialSources[0];
}

/**
 * Decides whether "expired" reports are strong enough to call a coupon invalid.
 * One low-quality site is not enough; an official page or two independent
 * domains are.
 */
export function assessExpiredReports(
  sources: readonly CouponSourceEntry[],
  now: Date,
): { reliable: boolean; detail: string } {
  const reporting = sources.filter(
    (source) => source.reportedExpired === true && hoursSince(source.lastSeenAt, now) <= 24 * 14,
  );
  if (reporting.length === 0) return { reliable: false, detail: '' };

  const officialReport = reporting.find((source) => source.type === 'official');
  if (officialReport) {
    return {
      reliable: true,
      detail: `official page lists this offer as expired (${officialReport.url})`,
    };
  }

  const domains = new Set(reporting.map((source) => normaliseDomain(source.domain ?? source.url)));
  if (domains.size >= 2) {
    return {
      reliable: true,
      detail: `${domains.size} independent sources report this offer as expired`,
    };
  }

  return {
    reliable: false,
    detail: `1 source reports this offer as expired (not sufficient on its own)`,
  };
}

function buildUnverifiedNote(coupon: ICoupon, independent: number, expiredHint: string): string {
  const parts: string[] = [];

  if (coupon.code) {
    parts.push(
      config.enableCartValidation
        ? 'the customer-facing coupon field could not be reached (empty guest cart, sign-in wall or anti-bot protection)'
        : 'cart validation is disabled',
    );
  } else {
    parts.push('promotion has no coupon code, so there is nothing to test in a cart');
  }

  parts.push(
    `${independent} independent recent third-party source(s) publish it; ` +
      'copies between coupon sites are not treated as confirmation',
  );

  if (coupon.isUpTo) parts.push('advertised as an "up to" offer, so the real value is unknown');
  if (coupon.selectedUsersOnly) parts.push('published as a selected-users offer');
  if (coupon.appOnly) parts.push('published as an app-only offer');
  if (coupon.selectedProductsOnly) parts.push('published as applying to selected products only');
  if (expiredHint) parts.push(expiredHint);

  return parts.join('; ');
}
