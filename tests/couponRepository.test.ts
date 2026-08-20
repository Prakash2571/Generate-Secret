import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applyExpiryState,
  buildDedupeKey,
  computeConflicts,
  isValidationDue,
  normaliseCode,
  refreshDerived,
} from '../src/db/couponRepository';
import type { CouponDocument } from '../src/db/models/Coupon';
import type { CouponCandidate } from '../src/types';
import { NOW, hoursAgo, makeCoupon, makeSource } from './helpers/fixtures';

function makeCandidate(overrides: Partial<CouponCandidate> = {}): CouponCandidate {
  return {
    discountType: 'flat',
    discountValue: 800,
    minimumOrder: 1000,
    isUpTo: false,
    minimumOrderKnown: true,
    rawText: 'Flat Rs.800 off on Rs.1000',
    source: {
      name: 'grabon',
      url: 'https://www.grabon.in/shein-coupons/',
      type: 'coupon-site',
      domain: 'grabon.in',
      discoveredAt: NOW,
      lastSeenAt: NOW,
    },
    ...overrides,
  };
}

/** Repository helpers operate on plain field access, so a literal stands in. */
const asDocument = (coupon: ReturnType<typeof makeCoupon>): CouponDocument =>
  coupon as unknown as CouponDocument;

describe('normaliseCode', () => {
  it('trims, uppercases and strips internal whitespace', () => {
    assert.equal(normaliseCode('  shein800 '), 'SHEIN800');
    assert.equal(normaliseCode('new 70'), 'NEW70');
    assert.equal(normaliseCode('SHEIN800'), 'SHEIN800');
  });

  it('returns undefined for empty input', () => {
    assert.equal(normaliseCode(undefined), undefined);
    assert.equal(normaliseCode(''), undefined);
    assert.equal(normaliseCode('   '), undefined);
  });
});

describe('buildDedupeKey', () => {
  it('keys coded offers on the code alone so publishers converge', () => {
    const fromGrabon = makeCandidate({ code: 'shein800' });
    const fromCashKaro = makeCandidate({
      code: 'SHEIN800',
      source: { ...makeCandidate().source, name: 'cashkaro', url: 'https://cashkaro.com/shein' },
    });

    assert.equal(buildDedupeKey(fromGrabon), 'CODE:SHEIN800');
    assert.equal(
      buildDedupeKey(fromGrabon),
      buildDedupeKey(fromCashKaro),
      'five sites publishing SHEIN800 must map to one coupon',
    );
  });

  it('fingerprints code-less promotions by their terms', () => {
    const sale = makeCandidate({
      code: undefined,
      discountType: 'sale',
      discountValue: 80,
      isUpTo: true,
      minimumOrder: undefined,
      minimumOrderKnown: false,
      title: 'UP TO 80% OFF SALE',
      rawText: 'UP TO 80% OFF SALE',
    });

    const key = buildDedupeKey(sale);
    assert.match(key, /^OFFER:[0-9a-f]{20}$/);
    assert.equal(buildDedupeKey(sale), key, 'the fingerprint must be stable');
  });

  it('separates promotions whose terms genuinely differ', () => {
    const first = makeCandidate({ code: undefined, discountValue: 800, title: 'A', rawText: 'A' });
    const second = makeCandidate({ code: undefined, discountValue: 500, title: 'B', rawText: 'B' });
    assert.notEqual(buildDedupeKey(first), buildDedupeKey(second));
  });
});

describe('computeConflicts', () => {
  it('reports no conflict when publishers agree', () => {
    const claim = { discountType: 'flat' as const, discountValue: 800, minimumOrder: 1000 };
    assert.equal(
      computeConflicts([makeSource({ claim }), makeSource({ domain: 'b.in', claim })]),
      false,
    );
  });

  it('detects disagreement on value, type or minimum order', () => {
    const base = { discountType: 'flat' as const, discountValue: 800, minimumOrder: 1000 };
    assert.equal(
      computeConflicts([
        makeSource({ claim: base }),
        makeSource({ claim: { ...base, discountValue: 500 } }),
      ]),
      true,
    );
    assert.equal(
      computeConflicts([
        makeSource({ claim: base }),
        makeSource({ claim: { ...base, discountType: 'percentage' } }),
      ]),
      true,
    );
    assert.equal(
      computeConflicts([
        makeSource({ claim: base }),
        makeSource({ claim: { ...base, minimumOrder: 1499 } }),
      ]),
      true,
    );
  });

  it('needs at least two concrete claims before flagging anything', () => {
    assert.equal(computeConflicts([]), false);
    assert.equal(
      computeConflicts([makeSource({ claim: { discountType: 'flat', discountValue: 800 } })]),
      false,
    );
    assert.equal(
      computeConflicts([
        makeSource({ claim: { discountType: 'flat', discountValue: 800 } }),
        makeSource({ claim: { discountType: 'unknown' } }),
      ]),
      false,
      'a vague claim is not a conflicting claim',
    );
  });

  it('does not treat an unpublished minimum as a conflict', () => {
    assert.equal(
      computeConflicts([
        makeSource({ claim: { discountType: 'flat', discountValue: 800, minimumOrder: 1000 } }),
        makeSource({ claim: { discountType: 'flat', discountValue: 800 } }),
      ]),
      false,
    );
  });
});

describe('applyExpiryState', () => {
  it('moves a past-expiry coupon to expired and records why', () => {
    const doc = asDocument(makeCoupon({ status: 'valid', expiryDate: hoursAgo(1) }));
    applyExpiryState(doc, NOW);
    assert.equal(doc.status, 'expired');
    assert.equal(doc.validationMethod, 'expiry-date');
    assert.match(String(doc.validationNotes), /has passed/);
  });

  it('leaves a future expiry alone', () => {
    const doc = asDocument(
      makeCoupon({ status: 'valid', expiryDate: new Date('2026-12-31T00:00:00Z') }),
    );
    applyExpiryState(doc, NOW);
    assert.equal(doc.status, 'valid');
  });
});

describe('refreshDerived', () => {
  it('recomputes confidence and the cached target analysis', () => {
    const doc = asDocument(makeCoupon({ confidence: 0, targetMatch: false }));
    refreshDerived(doc, NOW);
    assert.equal(doc.confidence, 10, 'one fresh third-party source');
    assert.equal(doc.targetMatch, true);
    assert.equal(doc.discountAtTarget, 800);
    assert.equal(doc.finalPriceAtTarget, 200);
    assert.equal(doc.effectiveDiscountAtTarget, 0.8);
  });

  it('leaves the payable price undefined when the offer cannot apply', () => {
    const doc = asDocument(
      makeCoupon({
        discountType: 'sale',
        discountValue: 80,
        isUpTo: true,
        minimumOrder: undefined,
        minimumOrderKnown: false,
      }),
    );
    refreshDerived(doc, NOW);
    assert.equal(doc.finalPriceAtTarget, undefined);
    assert.equal(doc.targetMatch, false);
  });
});

describe('isValidationDue', () => {
  it('rechecks valid coupons once a day', () => {
    assert.equal(
      isValidationDue(makeCoupon({ status: 'valid', lastValidatedAt: hoursAgo(12) }), NOW),
      false,
    );
    assert.equal(
      isValidationDue(makeCoupon({ status: 'valid', lastValidatedAt: hoursAgo(25) }), NOW),
      true,
    );
  });

  it('rechecks unverified and manual coupons far sooner', () => {
    for (const status of ['unverified', 'manual_validation_required'] as const) {
      assert.equal(
        isValidationDue(makeCoupon({ status, lastValidatedAt: hoursAgo(2) }), NOW),
        false,
        status,
      );
      assert.equal(
        isValidationDue(makeCoupon({ status, lastValidatedAt: hoursAgo(7) }), NOW),
        true,
        status,
      );
    }
  });

  it('revisits invalid coupons occasionally, since offers come back', () => {
    assert.equal(
      isValidationDue(makeCoupon({ status: 'invalid', lastValidatedAt: hoursAgo(48) }), NOW),
      false,
    );
    assert.equal(
      isValidationDue(makeCoupon({ status: 'invalid', lastValidatedAt: hoursAgo(80) }), NOW),
      true,
    );
  });

  it('always queues a never-validated coupon', () => {
    assert.equal(
      isValidationDue(makeCoupon({ status: 'unverified', lastValidatedAt: undefined }), NOW),
      true,
    );
  });

  it('never queues an expired coupon, but does queue one that just passed expiry', () => {
    assert.equal(isValidationDue(makeCoupon({ status: 'expired' }), NOW), false);
    assert.equal(
      isValidationDue(
        makeCoupon({ status: 'valid', lastValidatedAt: NOW, expiryDate: hoursAgo(1) }),
        NOW,
      ),
      true,
    );
  });
});
