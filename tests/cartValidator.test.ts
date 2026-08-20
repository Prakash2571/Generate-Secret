import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  classifyResponse,
  extractNewText,
  readTermsFromMessage,
} from '../src/validators/cartValidator';
import './helpers/setup';

describe('classifyResponse', () => {
  it('recognises an accepted coupon', () => {
    const result = classifyResponse('Coupon applied! Coupon discount \u20b9800', 'SHEIN800');
    assert.equal(result.verdict, 'accepted');
    assert.match(result.detail, /SHEIN800/);
  });

  it('recognises an explicit rejection', () => {
    for (const message of [
      'Invalid coupon code',
      'This coupon is expired',
      'Code does not exist',
      'This coupon cannot be used',
      'Coupon not applicable',
    ]) {
      assert.equal(classifyResponse(message, 'X1').verdict, 'rejected', message);
    }
  });

  it('recognises a recognised-but-unmet condition and keeps the revealed terms', () => {
    const result = classifyResponse('Minimum order value \u20b91299 required', 'X1');
    assert.equal(result.verdict, 'conditional');
    assert.equal(result.observedTerms?.minimumOrder, 1299);
    assert.equal(result.observedTerms?.minimumOrderKnown, true);
    assert.match(result.detail, /conditions unmet/);
  });

  it('treats sign-in, OTP and CAPTCHA as blocked rather than a failed coupon', () => {
    for (const message of [
      'Please sign in to continue',
      'Enter the OTP sent to your phone',
      'Please complete the captcha',
      'Access denied, unusual traffic detected',
    ]) {
      const result = classifyResponse(message, 'X1');
      assert.equal(result.verdict, 'blocked', message);
    }
  });

  it('prioritises a blocker over any other reading of the page', () => {
    // A login wall that also happens to contain rejection wording.
    const result = classifyResponse('Invalid coupon code. Please login to continue.', 'X1');
    assert.equal(result.verdict, 'blocked');
  });

  it('refuses to guess when the response is unclear', () => {
    const result = classifyResponse('Your bag is ready. Continue shopping.', 'X1');
    assert.equal(result.verdict, 'unavailable');
    assert.match(result.detail, /could not be interpreted/);
  });
});

describe('readTermsFromMessage', () => {
  it('extracts a minimum order the site discloses', () => {
    assert.equal(readTermsFromMessage('Min spend \u20b9999')?.minimumOrder, 999);
    assert.equal(readTermsFromMessage('minimum purchase of \u20b91,499')?.minimumOrder, 1499);
  });

  it('extracts a realised discount amount', () => {
    const terms = readTermsFromMessage('You saved \u20b9800 on this order');
    assert.equal(terms?.discountValue, 800);
    assert.equal(terms?.discountType, 'flat');
  });

  it('returns undefined when nothing quantitative is present', () => {
    assert.equal(readTermsFromMessage('Coupon applied'), undefined);
  });
});

describe('extractNewText', () => {
  it('returns only text that appeared after the interaction', () => {
    assert.equal(extractNewText('Bag total', 'Bag total Coupon applied'), ' Coupon applied');
  });

  it('falls back to a line diff when the page is rewritten', () => {
    const before = 'Bag total\n\u20b91000';
    const after = 'Bag total\n\u20b9200\nCoupon applied';
    const diff = extractNewText(before, after);
    assert.match(diff, /Coupon applied/);
    assert.doesNotMatch(diff, /Bag total/);
  });

  it('returns everything when there was no prior text', () => {
    assert.equal(extractNewText('', 'Coupon applied'), 'Coupon applied');
  });
});
