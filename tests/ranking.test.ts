import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compareRanked, decorate, pickBest, rankCoupons } from '../src/scoring/ranking';
import { NOW, daysAgo, makeCoupon, makeSource } from './helpers/fixtures';

describe('rankCoupons', () => {
  it('ranks by payable price, not by advertised percentage', () => {
    // The specification's own example: A advertises more but delivers less.
    const a = makeCoupon({
      code: 'A80',
      discountType: 'percentage',
      discountValue: 80,
      maximumDiscount: 300,
      minimumOrder: 1000,
      status: 'valid',
    });
    const b = makeCoupon({
      code: 'B600',
      discountType: 'flat',
      discountValue: 600,
      minimumOrder: 1000,
      status: 'valid',
    });

    const ranked = rankCoupons([a, b], NOW);
    assert.equal(ranked[0]?.coupon.code, 'B600');
    assert.equal(ranked[0]?.analysis.finalPriceAtTarget, 400);
    assert.equal(ranked[1]?.analysis.finalPriceAtTarget, 700);
  });

  it('puts validity above every other signal', () => {
    const betterButUnverified = makeCoupon({
      code: 'UNV',
      discountValue: 900,
      status: 'unverified',
      confidence: 100,
    });
    const worseButValid = makeCoupon({ code: 'VAL', discountValue: 300, status: 'valid', confidence: 10 });

    const ranked = rankCoupons([betterButUnverified, worseButValid], NOW);
    assert.deepEqual(
      ranked.map((entry) => entry.coupon.code),
      ['VAL', 'UNV'],
    );
  });

  it('orders the remaining statuses sensibly', () => {
    const statuses = ['expired', 'invalid', 'unverified', 'manual_validation_required', 'valid'] as const;
    const coupons = statuses.map((status) =>
      makeCoupon({ code: status.toUpperCase(), status, dedupeKey: `CODE:${status}` }),
    );
    const ranked = rankCoupons(coupons, NOW);
    assert.deepEqual(
      ranked.map((entry) => entry.coupon.status),
      ['valid', 'manual_validation_required', 'unverified', 'invalid', 'expired'],
    );
  });

  it('sinks offers that cannot be applied at the target value', () => {
    const sale = makeCoupon({
      code: 'SALE',
      discountType: 'sale',
      discountValue: 80,
      isUpTo: true,
      minimumOrderKnown: false,
      minimumOrder: undefined,
      status: 'valid',
    });
    const small = makeCoupon({ code: 'SMALL', discountValue: 100, status: 'valid' });

    const ranked = rankCoupons([sale, small], NOW);
    assert.equal(ranked[0]?.coupon.code, 'SMALL');
  });

  it('prefers provable terms when the numbers are identical', () => {
    const provable = makeCoupon({ code: 'SURE', discountValue: 800, minimumOrder: 1000, status: 'valid' });
    const assumed = makeCoupon({
      code: 'MAYBE',
      discountValue: 800,
      minimumOrder: undefined,
      minimumOrderKnown: false,
      status: 'valid',
    });

    const ranked = rankCoupons([assumed, provable], NOW);
    assert.equal(ranked[0]?.coupon.code, 'SURE');
    assert.equal(ranked[0]?.targetMatch, true);
    assert.equal(ranked[1]?.analysis.potentialTargetMatch, true);
  });

  it('breaks price ties on confidence, then freshness, then source count', () => {
    const base = { discountValue: 500, minimumOrder: 1000, status: 'valid' as const };

    const byConfidence = rankCoupons(
      [
        makeCoupon({ ...base, code: 'LOWCONF', confidence: 40 }),
        makeCoupon({ ...base, code: 'HIGHCONF', confidence: 90 }),
      ],
      NOW,
    );
    assert.equal(byConfidence[0]?.coupon.code, 'HIGHCONF');

    const byFreshness = rankCoupons(
      [
        makeCoupon({ ...base, code: 'OLD', confidence: 50, lastSeenAt: daysAgo(5) }),
        makeCoupon({ ...base, code: 'NEW', confidence: 50, lastSeenAt: NOW }),
      ],
      NOW,
    );
    assert.equal(byFreshness[0]?.coupon.code, 'NEW');

    const bySources = rankCoupons(
      [
        makeCoupon({ ...base, code: 'ONESRC', confidence: 50 }),
        makeCoupon({
          ...base,
          code: 'MANYSRC',
          confidence: 50,
          sources: [
            makeSource({ domain: 'a.in', url: 'https://a.in/x' }),
            makeSource({ domain: 'b.in', url: 'https://b.in/x' }),
          ],
        }),
      ],
      NOW,
    );
    assert.equal(bySources[0]?.coupon.code, 'MANYSRC');
  });

  it('is deterministic for otherwise identical coupons', () => {
    const one = makeCoupon({ code: 'AAA1', status: 'valid' });
    const two = makeCoupon({ code: 'BBB1', status: 'valid' });
    assert.equal(rankCoupons([two, one], NOW)[0]?.coupon.code, 'AAA1');
    assert.equal(rankCoupons([one, two], NOW)[0]?.coupon.code, 'AAA1');
  });

  it('does not mutate the input array', () => {
    const coupons = [
      makeCoupon({ code: 'Z', discountValue: 100, status: 'valid' }),
      makeCoupon({ code: 'A', discountValue: 900, status: 'valid' }),
    ];
    const before = coupons.map((coupon) => coupon.code);
    rankCoupons(coupons, NOW);
    assert.deepEqual(
      coupons.map((coupon) => coupon.code),
      before,
    );
  });
});

describe('decorate', () => {
  it('attaches the analysis and independent source count', () => {
    const entry = decorate(
      makeCoupon({
        sources: [
          makeSource({ domain: 'a.in', url: 'https://a.in/x' }),
          makeSource({ domain: 'b.in', url: 'https://b.in/x' }),
        ],
      }),
      NOW,
    );
    assert.equal(entry.independentSources, 2);
    assert.equal(entry.targetMatch, true);
    assert.equal(entry.analysis.finalPriceAtTarget, 200);
  });
});

describe('pickBest', () => {
  it('returns the top entry, optionally restricted to a status group', () => {
    const ranked = rankCoupons(
      [
        makeCoupon({ code: 'BESTVALID', discountValue: 700, status: 'valid' }),
        makeCoupon({ code: 'CHEAPUNV', discountValue: 950, status: 'unverified' }),
      ],
      NOW,
    );
    assert.equal(pickBest(ranked)?.coupon.code, 'BESTVALID');
    assert.equal(pickBest(ranked, ['unverified'])?.coupon.code, 'CHEAPUNV');
    assert.equal(pickBest(ranked, ['invalid']), undefined);
    assert.equal(pickBest([]), undefined);
  });
});

describe('compareRanked', () => {
  it('is usable directly as a sort comparator', () => {
    const entries = [
      decorate(makeCoupon({ code: 'PRICEY', discountValue: 100, status: 'valid' }), NOW),
      decorate(makeCoupon({ code: 'CHEAP', discountValue: 800, status: 'valid' }), NOW),
    ];
    entries.sort(compareRanked);
    assert.equal(entries[0]?.coupon.code, 'CHEAP');
  });
});
