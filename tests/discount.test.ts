import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  analyzeCoupon,
  calculateDiscount,
  calculateFinalPrice,
  describeUncertainty,
  formatOffer,
  formatRupees,
  type CouponLike,
} from '../src/calculations/discount';

const flat800: CouponLike = {
  discountType: 'flat',
  discountValue: 800,
  minimumOrder: 1000,
  isUpTo: false,
  minimumOrderKnown: true,
};

describe('calculateDiscount', () => {
  it('applies a flat discount and computes the payable amount', () => {
    const result = calculateDiscount(flat800, 1000);
    assert.equal(result.discount, 800);
    assert.equal(result.finalPrice, 200);
    assert.equal(result.effectiveDiscount, 0.8);
    assert.equal(result.applicable, true);
  });

  it('refuses to apply below a published minimum order', () => {
    const result = calculateDiscount(flat800, 999);
    assert.equal(result.discount, 0);
    assert.equal(result.finalPrice, 999);
    assert.equal(result.applicable, false);
    assert.match(String(result.reason), /below published minimum/);
  });

  it('caps a percentage discount at its maximum', () => {
    const capped: CouponLike = {
      discountType: 'percentage',
      discountValue: 80,
      maximumDiscount: 300,
      isUpTo: false,
      minimumOrderKnown: false,
    };
    assert.equal(calculateDiscount(capped, 1000).discount, 300);
    assert.equal(calculateDiscount(capped, 300).discount, 240);
  });

  it('never claims a discount larger than the cart', () => {
    const huge: CouponLike = {
      discountType: 'flat',
      discountValue: 5000,
      isUpTo: false,
      minimumOrderKnown: false,
    };
    const result = calculateDiscount(huge, 1000);
    assert.equal(result.discount, 1000);
    assert.equal(result.finalPrice, 0);
  });

  it('credits nothing for up-to offers, sales, cashback or unparsed terms', () => {
    const cases: Array<[string, CouponLike]> = [
      ['up-to', { discountType: 'percentage', discountValue: 80, isUpTo: true, minimumOrderKnown: false }],
      ['sale', { discountType: 'sale', discountValue: 80, isUpTo: false, minimumOrderKnown: false }],
      ['cashback', { discountType: 'cashback', discountValue: 200, isUpTo: false, minimumOrderKnown: false }],
      ['unknown', { discountType: 'unknown', isUpTo: false, minimumOrderKnown: false }],
      ['missing value', { discountType: 'flat', isUpTo: false, minimumOrderKnown: false }],
    ];
    for (const [label, coupon] of cases) {
      const result = calculateDiscount(coupon, 1000);
      assert.equal(result.discount, 0, `${label} must not credit a discount`);
      assert.equal(result.applicable, false, `${label} must not be applicable`);
      assert.ok(result.reason, `${label} must explain why`);
    }
  });

  it('rejects a non-positive cart value', () => {
    assert.equal(calculateDiscount(flat800, 0).applicable, false);
  });
});

describe('calculateFinalPrice', () => {
  it('returns the amount actually payable', () => {
    assert.equal(calculateFinalPrice(flat800, 1000), 200);
    assert.equal(calculateFinalPrice(flat800, 1499), 699);
    assert.equal(calculateFinalPrice(flat800, 999), 999);
  });
});

describe('analyzeCoupon', () => {
  it('reports every required cart value', () => {
    const analysis = analyzeCoupon(flat800);
    const values = analysis.breakdowns.map((entry) => entry.cartValue);
    for (const expected of [999, 1000, 1099, 1199, 1299, 1499, 1999]) {
      assert.ok(values.includes(expected), `missing cart value ${expected}`);
    }
    assert.deepEqual(values, [...values].sort((a, b) => a - b), 'ladder must be sorted');
  });

  it('awards TARGET_MATCH only when the target is provably reached', () => {
    const analysis = analyzeCoupon(flat800);
    assert.equal(analysis.discountAtTarget, 800);
    assert.equal(analysis.finalPriceAtTarget, 200);
    assert.equal(analysis.effectiveDiscountAtTarget, 0.8);
    assert.equal(analysis.targetMatch, true);
    assert.equal(analysis.potentialTargetMatch, false);
    assert.equal(analysis.uncertain, false);
  });

  it('downgrades to POTENTIAL_TARGET_MATCH when terms were assumed', () => {
    const analysis = analyzeCoupon({
      discountType: 'flat',
      discountValue: 800,
      isUpTo: false,
      minimumOrderKnown: false,
    });
    assert.equal(analysis.discountAtTarget, 800);
    assert.equal(analysis.targetMatch, false, 'must not claim a provable match');
    assert.equal(analysis.potentialTargetMatch, true);
    assert.equal(analysis.uncertain, true);
    assert.match(String(analysis.uncertaintyReason), /minimum order not published/);
  });

  it('withholds the target tag when the discount is too small', () => {
    const analysis = analyzeCoupon({
      discountType: 'flat',
      discountValue: 600,
      minimumOrder: 1000,
      isUpTo: false,
      minimumOrderKnown: true,
    });
    assert.equal(analysis.targetMatch, false);
    assert.equal(analysis.potentialTargetMatch, false);
    assert.equal(analysis.finalPriceAtTarget, 400);
  });

  it('honours an explicit target override', () => {
    const analysis = analyzeCoupon(flat800, { targetCartValue: 1499, targetDiscount: 700 });
    assert.equal(analysis.targetCartValue, 1499);
    assert.equal(analysis.discountAtTarget, 800);
    assert.equal(analysis.targetMatch, true);
  });
});

describe('describeUncertainty', () => {
  it('explains each source of doubt', () => {
    assert.match(
      String(describeUncertainty({ discountType: 'percentage', discountValue: 80, isUpTo: true, minimumOrderKnown: true })),
      /up to/,
    );
    assert.match(
      String(describeUncertainty({ discountType: 'percentage', discountValue: 70, isUpTo: false, minimumOrderKnown: true })),
      /without a published cap/,
    );
    assert.equal(describeUncertainty(flat800), undefined, 'fully published terms are certain');
  });
});

describe('formatting', () => {
  it('distinguishes offer kinds in human output', () => {
    assert.equal(formatOffer(flat800), '\u20b9800 OFF');
    assert.equal(
      formatOffer({ discountType: 'percentage', discountValue: 70, isUpTo: false, minimumOrderKnown: false }),
      '70% OFF',
    );
    assert.equal(
      formatOffer({ discountType: 'percentage', discountValue: 80, isUpTo: true, minimumOrderKnown: false }),
      'UP TO 80% OFF',
    );
    assert.equal(
      formatOffer({ discountType: 'sale', discountValue: 80, isUpTo: true, minimumOrderKnown: false }),
      'UP TO 80% SALE',
    );
    assert.equal(
      formatOffer({ discountType: 'unknown', isUpTo: false, minimumOrderKnown: false }),
      'UNKNOWN OFFER',
    );
  });

  it('formats rupees with Indian grouping and handles missing values', () => {
    assert.equal(formatRupees(1000), '\u20b91,000');
    assert.equal(formatRupees(200), '\u20b9200');
    assert.equal(formatRupees(undefined), '-');
    assert.equal(formatRupees(null), '-');
  });
});
