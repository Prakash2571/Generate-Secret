import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { calculateDiscount } from '../src/calculations/discount';
import {
  isEmptyOffer,
  looksLikeSheinIndia,
  normaliseText,
  parseAmount,
  parseExpiryDate,
  parseOfferTerms,
} from '../src/extractors/promotionParser';
import { NOW } from './helpers/fixtures';

const parse = (text: string) => parseOfferTerms(text, { now: NOW });

describe('normaliseText', () => {
  it('unifies currency spellings so one set of patterns works', () => {
    assert.equal(normaliseText('Rs.800 off'), '\u20b9800 off');
    assert.equal(normaliseText('Rs 800 off'), '\u20b9800 off');
    assert.equal(normaliseText('INR 800 off'), '\u20b9800 off');
    assert.equal(normaliseText('800/- off'), '800 off');
  });

  it('collapses whitespace and normalises quotes and dashes', () => {
    assert.equal(normaliseText('  80%   off\n\nsale  '), '80% off sale');
    assert.equal(normaliseText('valid \u2013 today'), 'valid - today');
  });
});

describe('parseAmount', () => {
  it('accepts Indian digit grouping', () => {
    assert.equal(parseAmount('1,000'), 1000);
    assert.equal(parseAmount('999'), 999);
  });

  it('rejects values that are not money', () => {
    assert.equal(parseAmount(undefined), undefined);
    assert.equal(parseAmount(''), undefined);
    assert.equal(parseAmount('abc'), undefined);
    assert.equal(parseAmount('0'), undefined);
    // Guards against parsing ids or pin codes as rupees.
    assert.equal(parseAmount('99999999'), undefined);
  });
});

describe('flat offers', () => {
  it('parses "Flat Rs.800 off on orders above Rs.1,000"', () => {
    const terms = parse('Flat Rs.800 off on orders above Rs.1,000');
    assert.equal(terms.discountType, 'flat');
    assert.equal(terms.discountValue, 800);
    assert.equal(terms.minimumOrder, 1000);
    assert.equal(terms.minimumOrderKnown, true);
    assert.equal(terms.isUpTo, false);
  });

  it('parses the combined "Rs.800 off Rs.1,000" form', () => {
    const terms = parse('Rs.800 off Rs.1,000');
    assert.equal(terms.discountValue, 800);
    assert.equal(terms.minimumOrder, 1000);
    assert.equal(terms.minimumOrderKnown, true);
  });

  it('does not invent a minimum order that was never published', () => {
    const terms = parse('Get Rs.500 off on SHEIN India');
    assert.equal(terms.discountValue, 500);
    assert.equal(terms.minimumOrderKnown, false);
    assert.equal(terms.minimumOrder, undefined);
  });

  it('ignores a "minimum" smaller than the discount itself as a misparse', () => {
    const terms = parse('Rs.800 off. Minimum Rs.100 cart? no.');
    assert.equal(terms.discountValue, 800);
    assert.equal(terms.minimumOrderKnown, false);
  });

  it('reads a minimum from several phrasings', () => {
    for (const text of [
      'Rs.300 off, min order value Rs.1499',
      'Rs.300 off on purchase of Rs.1499',
      'Rs.300 off on Rs.1499 or more',
      'Rs.300 off minimum purchase Rs.1499',
    ]) {
      const terms = parse(text);
      assert.equal(terms.minimumOrder, 1499, `failed for: ${text}`);
      assert.equal(terms.minimumOrderKnown, true, `failed for: ${text}`);
    }
  });
});

describe('percentage offers and the "up to" trap', () => {
  it('treats "UP TO 80% OFF SALE" as a sale, never an 80% coupon', () => {
    const terms = parse('UP TO 80% OFF SALE');
    assert.equal(terms.discountType, 'sale');
    assert.equal(terms.isUpTo, true);
    // The critical assertion: no guaranteed discount may be credited.
    const breakdown = calculateDiscount(terms, 1000);
    assert.equal(breakdown.discount, 0);
    assert.equal(breakdown.applicable, false);
  });

  it('treats "up to 80% off" as an upper bound even without sale wording', () => {
    const terms = parse('Up to 80% off for new users');
    assert.equal(terms.isUpTo, true);
    assert.equal(calculateDiscount(terms, 1000).discount, 0);
  });

  it('reads "70% off up to Rs.700" as a capped percentage, not a hedge', () => {
    const terms = parse('70% OFF up to Rs.700, min purchase Rs.999');
    assert.equal(terms.discountType, 'percentage');
    assert.equal(terms.discountValue, 70);
    assert.equal(terms.maximumDiscount, 700);
    assert.equal(terms.isUpTo, false);
    assert.equal(calculateDiscount(terms, 1000).discount, 700);
  });

  it('reads "max discount Rs.300" as a cap', () => {
    const terms = parse('60% off, maximum discount Rs.300 on selected items');
    assert.equal(terms.maximumDiscount, 300);
    assert.equal(calculateDiscount(terms, 1000).discount, 300);
  });

  it('treats "up to Rs.800 off" (no percentage) as a hedged flat offer', () => {
    const terms = parse('Save up to Rs.800 off your order');
    assert.equal(terms.isUpTo, true);
    assert.equal(calculateDiscount(terms, 1000).discount, 0);
  });

  it('honours "flat 70% off" as an exact percentage', () => {
    const terms = parse('Flat 70% off on SHEIN India, min Rs.999');
    assert.equal(terms.discountType, 'percentage');
    assert.equal(terms.discountValue, 70);
    assert.equal(terms.isUpTo, false);
  });

  it('rejects implausible percentages', () => {
    const terms = parse('99% off everything forever 120% off');
    assert.notEqual(terms.discountValue, 120);
  });
});

describe('cashback is not a checkout discount', () => {
  it('classifies cashback separately and credits no discount', () => {
    const terms = parse('Flat Rs.200 cashback on SHEIN India orders above Rs.999');
    assert.equal(terms.discountType, 'cashback');
    const breakdown = calculateDiscount(terms, 1000);
    assert.equal(breakdown.discount, 0);
    assert.match(String(breakdown.reason), /cashback/i);
  });
});

describe('eligibility and restriction flags', () => {
  it('detects every restriction that must be surfaced to the user', () => {
    const terms = parse(
      'New users only: 80% off up to Rs.300 on your first order, app only, on selected products. Selected users.',
    );
    assert.equal(terms.newUsersOnly, true);
    assert.equal(terms.firstOrderOnly, true);
    assert.equal(terms.appOnly, true);
    assert.equal(terms.selectedProductsOnly, true);
    assert.equal(terms.selectedUsersOnly, true);
  });

  it('detects app-only phrasing variants', () => {
    for (const text of [
      'Rs.500 off, app only',
      'Rs.500 off exclusively on the app',
      'Rs.500 off, mobile app only',
      'Rs.500 off available only on the app',
    ]) {
      assert.equal(parse(text).appOnly, true, `failed for: ${text}`);
    }
  });

  it('records existing-user eligibility only when new-user is not claimed', () => {
    assert.equal(parse('Rs.500 off for existing users').existingUsersAllowed, true);
    assert.equal(parse('Rs.500 off for new users only').existingUsersAllowed, undefined);
  });

  it('records when a publisher says the offer is dead', () => {
    assert.equal(parse('This SHEIN coupon has expired').reportedExpired, true);
    assert.equal(parse('Coupon no longer working').reportedExpired, true);
    assert.equal(parse('Rs.800 off Rs.1000').reportedExpired, undefined);
  });
});

describe('parseExpiryDate', () => {
  it('parses "31 August 2026" without mistaking the year for the day', () => {
    const date = parseExpiryDate('Offer valid till 31 August 2026', NOW);
    assert.ok(date);
    assert.equal(date.getUTCFullYear(), 2026);
    assert.equal(date.getUTCMonth(), 7);
    assert.equal(date.getUTCDate(), 31);
  });

  it('parses month-first and Indian numeric formats', () => {
    const monthFirst = parseExpiryDate('Expires August 31, 2026', NOW);
    assert.equal(monthFirst?.getUTCDate(), 31);

    const numeric = parseExpiryDate('Valid until 30/09/2026', NOW);
    assert.equal(numeric?.getUTCDate(), 30);
    assert.equal(numeric?.getUTCMonth(), 8);
  });

  it('requires expiry wording, so random dates are not treated as expiry', () => {
    assert.equal(parseExpiryDate('Published on 1 January 2026', NOW), undefined);
  });

  it('ignores implausible dates far outside the current window', () => {
    assert.equal(parseExpiryDate('valid till 31 August 1999', NOW), undefined);
  });

  it('expires at end of day so an offer valid "till 31 Aug" works on the 31st', () => {
    const date = parseExpiryDate('valid till 31 August 2026', NOW);
    assert.equal(date?.getUTCHours(), 23);
  });
});

describe('helpers', () => {
  it('looksLikeSheinIndia requires both SHEIN and an India signal', () => {
    assert.equal(looksLikeSheinIndia('SHEIN India coupon'), true);
    assert.equal(looksLikeSheinIndia('SHEIN Rs.800 off'), true);
    assert.equal(looksLikeSheinIndia('SHEIN US coupon $20 off'), false);
    assert.equal(looksLikeSheinIndia('Myntra India coupon'), false);
  });

  it('isEmptyOffer detects text with no usable discount information', () => {
    assert.equal(isEmptyOffer(parse('Shop the latest styles now')), true);
    assert.equal(isEmptyOffer(parse('Rs.800 off Rs.1000')), false);
  });
});
