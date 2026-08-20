import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as cheerio from 'cheerio';
import { findPromoLinks } from '../src/collectors/officialShein';
import './helpers/setup';

function cheerioAvailable(): boolean {
  try {
    cheerio.load('<p>ok</p>');
    return true;
  } catch {
    return false;
  }
}

const anchors = (...hrefs: Array<[string, string]>): string =>
  `<html><body>${hrefs
    .map(([href, text]) => `<a href="${href}">${text}</a>`)
    .join('')}</body></html>`;

describe(
  'findPromoLinks',
  { skip: cheerioAvailable() ? false : 'cheerio is not installed' },
  () => {
    const base = 'https://www.shein.in/';

    it('follows genuine coupon and promotion links', () => {
      const links = findPromoLinks(
        anchors(
          ['/coupon-a-1035.html', 'Coupons'],
          ['/promotion', 'Promotions'],
          ['/campaign/new-in', 'New user offer'],
        ),
        base,
      );
      assert.ok(links.includes('https://www.shein.in/coupon-a-1035.html'));
      assert.ok(links.includes('https://www.shein.in/promotion'));
      assert.ok(links.includes('https://www.shein.in/campaign/new-in'));
    });

    it('ignores category and product listing pages', () => {
      // These are exactly the noisy pages the crawler used to wander into.
      const links = findPromoLinks(
        anchors(
          ['/hotsale/Beachwear-sc-003147526.html', 'Beachwear Sale'],
          ['/recommend/us-sale-sc-10050051620.html', 'US Sale'],
          ['/sale/All-Sale-sc-0051884505.html?ici=nav', 'All Sale'],
          ['/some-product-p-12345.html', 'A product'],
        ),
        base,
      );
      assert.deepEqual(links, [], 'category/product pages must not be crawled');
    });

    it('never crosses to a non-India SHEIN market', () => {
      const links = findPromoLinks(
        anchors(
          ['https://us.shein.com/coupon', 'US coupons'],
          ['https://ar.shein.com/promotion', 'AR promo'],
          ['https://www.shein.in/coupon-a-1035.html', 'IN coupons'],
        ),
        base,
      );
      assert.deepEqual(links, ['https://www.shein.in/coupon-a-1035.html']);
    });

    it('accepts the in.shein.com host as India', () => {
      const links = findPromoLinks(anchors(['https://in.shein.com/promotion', 'Promo']), base);
      assert.deepEqual(links, ['https://in.shein.com/promotion']);
    });

    it('requires a promotional hint in the href or link text', () => {
      const links = findPromoLinks(
        anchors(['/about-us', 'About'], ['/help/shipping', 'Shipping']),
        base,
      );
      assert.deepEqual(links, []);
    });

    it('resolves relative links and strips fragments, de-duplicating', () => {
      const links = findPromoLinks(
        anchors(['/promotion#top', 'Promo'], ['/promotion', 'Promo again']),
        base,
      );
      assert.deepEqual(links, ['https://www.shein.in/promotion']);
    });

    it('rejects non-https links', () => {
      assert.deepEqual(findPromoLinks(anchors(['http://www.shein.in/coupon', 'x']), base), []);
    });

    it('returns an empty list for malformed markup rather than throwing', () => {
      assert.deepEqual(findPromoLinks('<a href=', base), []);
    });
  },
);
