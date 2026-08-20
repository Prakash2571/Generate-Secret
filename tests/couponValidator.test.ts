import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ValidationContext } from '../src/validators/couponValidator';
import {
  assessExpiredReports,
  freshestOfficialSource,
  validateCoupon,
} from '../src/validators/couponValidator';
import { NOW, daysAgo, hoursAgo, makeCoupon, makeOfficialSource, makeSource } from './helpers/fixtures';

/**
 * cartBudget starts at 0 so no test can reach the browser: these tests cover
 * the decision cascade, not the Playwright interaction.
 */
function context(overrides: Partial<ValidationContext> = {}): ValidationContext {
  return {
    signal: new AbortController().signal,
    now: NOW,
    cartBudget: { remaining: 0 },
    ...overrides,
  };
}

describe('validateCoupon cascade', () => {
  it('marks a coupon expired when its published expiry has passed', async () => {
    const outcome = await validateCoupon(
      makeCoupon({ status: 'valid', expiryDate: hoursAgo(2) }),
      context(),
    );
    assert.equal(outcome.status, 'expired');
    assert.equal(outcome.method, 'expiry-date');
  });

  it('accepts a current official publication as strong evidence', async () => {
    const outcome = await validateCoupon(
      makeCoupon({ sources: [makeOfficialSource({ lastSeenAt: hoursAgo(1) })] }),
      context(),
    );
    assert.equal(outcome.status, 'valid');
    assert.equal(outcome.method, 'official-publication');
    assert.match(outcome.notes, /official SHEIN India page/);
  });

  it('will not treat a stale official publication as current', async () => {
    const outcome = await validateCoupon(
      makeCoupon({ sources: [makeOfficialSource({ lastSeenAt: hoursAgo(72) })] }),
      context(),
    );
    assert.equal(outcome.status, 'unverified');
  });

  it('never promotes third-party copies to valid, however many there are', async () => {
    const sources = ['grabon.in', 'coupondunia.in', 'cashkaro.com', 'desidime.com', 'site5.in'].map(
      (domain) => makeSource({ name: domain, domain, url: `https://${domain}/shein` }),
    );

    const outcome = await validateCoupon(makeCoupon({ sources }), context());
    assert.equal(outcome.status, 'unverified');
    assert.equal(outcome.method, 'public-sources-only');
    assert.match(outcome.notes, /not treated as confirmation/);
    assert.match(outcome.notes, /5 independent recent third-party source/);
  });

  it('calls a coupon invalid when two independent sources report it expired', async () => {
    const outcome = await validateCoupon(
      makeCoupon({
        sources: [
          makeSource({ domain: 'grabon.in', url: 'https://grabon.in/x', reportedExpired: true }),
          makeSource({ domain: 'cashkaro.com', url: 'https://cashkaro.com/x', reportedExpired: true }),
        ],
      }),
      context(),
    );
    assert.equal(outcome.status, 'invalid');
    assert.equal(outcome.method, 'source-expiry-reports');
    assert.match(outcome.notes, /2 independent sources/);
  });

  it('does not call a coupon invalid on a single expiry report', async () => {
    const outcome = await validateCoupon(
      makeCoupon({ sources: [makeSource({ reportedExpired: true })] }),
      context(),
    );
    assert.equal(outcome.status, 'unverified');
    assert.match(outcome.notes, /not sufficient on its own/);
  });

  it('trusts an official page that lists the offer as expired', async () => {
    const outcome = await validateCoupon(
      makeCoupon({ sources: [makeOfficialSource({ reportedExpired: true })] }),
      context(),
    );
    assert.equal(outcome.status, 'invalid');
    assert.match(outcome.notes, /official page lists this offer as expired/);
  });

  it('explains that a code-less promotion cannot be tested in a cart', async () => {
    const outcome = await validateCoupon(makeCoupon({ code: undefined }), context());
    assert.equal(outcome.status, 'unverified');
    assert.match(outcome.notes, /no coupon code/);
  });

  it('surfaces the restrictions that block confident validation', async () => {
    const outcome = await validateCoupon(
      makeCoupon({
        isUpTo: true,
        appOnly: true,
        selectedUsersOnly: true,
        selectedProductsOnly: true,
      }),
      context(),
    );
    assert.match(outcome.notes, /"up to" offer/);
    assert.match(outcome.notes, /app-only/);
    assert.match(outcome.notes, /selected-users/);
    assert.match(outcome.notes, /selected products/);
  });

  it('leaves the cart budget untouched when it is exhausted', async () => {
    const ctx = context({ cartBudget: { remaining: 0 } });
    await validateCoupon(makeCoupon(), ctx);
    assert.equal(ctx.cartBudget.remaining, 0);
  });
});

describe('freshestOfficialSource', () => {
  it('returns the most recent official source inside the freshness window', () => {
    const older = makeOfficialSource({ url: 'https://shein.in/a', lastSeenAt: hoursAgo(30) });
    const newer = makeOfficialSource({ url: 'https://shein.in/b', lastSeenAt: hoursAgo(2) });
    assert.equal(freshestOfficialSource([older, newer], NOW)?.url, 'https://shein.in/b');
  });

  it('ignores third-party, stale and expired-reporting official sources', () => {
    assert.equal(freshestOfficialSource([makeSource()], NOW), undefined);
    assert.equal(
      freshestOfficialSource([makeOfficialSource({ lastSeenAt: daysAgo(5) })], NOW),
      undefined,
    );
    assert.equal(
      freshestOfficialSource([makeOfficialSource({ reportedExpired: true })], NOW),
      undefined,
    );
  });
});

describe('assessExpiredReports', () => {
  it('ignores expiry reports that are themselves ancient', () => {
    const result = assessExpiredReports(
      [makeSource({ reportedExpired: true, lastSeenAt: daysAgo(30) })],
      NOW,
    );
    assert.equal(result.reliable, false);
  });

  it('counts domains rather than pages', () => {
    const sameDomainTwice = assessExpiredReports(
      [
        makeSource({ url: 'https://www.grabon.in/a', domain: 'grabon.in', reportedExpired: true }),
        makeSource({ url: 'https://m.grabon.in/b', domain: 'm.grabon.in', reportedExpired: true }),
      ],
      NOW,
    );
    assert.equal(sameDomainTwice.reliable, false, 'one publisher is not two confirmations');
  });

  it('returns no detail when nothing reports an expiry', () => {
    const result = assessExpiredReports([makeSource()], NOW);
    assert.equal(result.reliable, false);
    assert.equal(result.detail, '');
  });
});
