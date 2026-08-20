import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as cheerio from 'cheerio';
import {
  extractCandidatesFromHtml,
  extractCandidatesFromText,
  extractCodeFromText,
  isPlausibleCode,
  type ExtractContext,
} from '../src/extractors/couponExtractor';
import { NOW } from './helpers/fixtures';

const context = (overrides: Partial<ExtractContext> = {}): ExtractContext => ({
  url: 'https://www.grabon.in/shein-coupons/',
  sourceName: 'grabon',
  sourceType: 'coupon-site',
  now: NOW,
  pageIsAboutShein: true,
  ...overrides,
});

describe('isPlausibleCode', () => {
  it('accepts realistic codes', () => {
    for (const code of ['SHEIN800', 'SALE50', 'NEW70', 'FIRST200', 'IN800OFF']) {
      assert.equal(isPlausibleCode(code), true, code);
    }
  });

  it('rejects vocabulary that only looks like a code', () => {
    for (const token of ['SHEIN', 'OFFER', 'SALE', 'CODE', 'INDIA', 'FREE', 'TODAY', 'HTTPS']) {
      assert.equal(isPlausibleCode(token), false, token);
    }
  });

  it('rejects bare numbers, short tokens and over-long tokens', () => {
    assert.equal(isPlausibleCode('1000'), false, 'a price is not a code');
    assert.equal(isPlausibleCode('800'), false);
    assert.equal(isPlausibleCode('AB1'), false, 'too short');
    assert.equal(isPlausibleCode('A'.repeat(30)), false, 'too long');
    assert.equal(isPlausibleCode('SHEIN 800'), false, 'spaces are not allowed');
  });

  it('requires a digit unless the code came from explicit "use code" wording', () => {
    assert.equal(isPlausibleCode('FREESHIP'), false);
    assert.equal(isPlausibleCode('FREESHIP', true), true);
  });

  it('rejects hyphenated sentence fragments', () => {
    assert.equal(isPlausibleCode('GET-80-OFF-NOW-TODAY', true), false);
  });

  it('normalises case before judging', () => {
    assert.equal(isPlausibleCode('shein800'), true);
  });
});

describe('extractCodeFromText', () => {
  it('reads codes from explicit coupon wording', () => {
    assert.equal(extractCodeFromText('Use code SHEIN800 to get Rs.800 off'), 'SHEIN800');
    assert.equal(extractCodeFromText('Coupon code: NEW70'), 'NEW70');
    assert.equal(extractCodeFromText('Apply promo code SAVE30 at bag'), 'SAVE30');
    assert.equal(extractCodeFromText('code - FIRST500'), 'FIRST500');
  });

  it('does not mistake prose for a code', () => {
    assert.equal(extractCodeFromText('use code at checkout to save'), undefined);
    assert.equal(extractCodeFromText('Use code freeship now'), undefined, 'lowercase is prose');
    assert.equal(extractCodeFromText('Use code Shein800'), undefined, 'mixed case is prose');
    assert.equal(extractCodeFromText('Great discounts on SHEIN India today'), undefined);
  });

  it('normalises whatever it finds', () => {
    assert.equal(extractCodeFromText('use coupon code shein800 now'), undefined);
    assert.equal(extractCodeFromText('USE CODE SHEIN800 NOW'), 'SHEIN800');
  });
});

describe('extractCandidatesFromText', () => {
  it('extracts a coded offer with its parsed terms and source lineage', () => {
    const candidates = extractCandidatesFromText(
      'Use code SHEIN800 to get Rs.800 off on orders above Rs.1,000 at SHEIN India',
      context(),
    );

    assert.equal(candidates.length, 1);
    const [candidate] = candidates;
    assert.equal(candidate?.code, 'SHEIN800');
    assert.equal(candidate?.discountType, 'flat');
    assert.equal(candidate?.discountValue, 800);
    assert.equal(candidate?.minimumOrder, 1000);
    assert.equal(candidate?.minimumOrderKnown, true);

    assert.equal(candidate?.source.name, 'grabon');
    assert.equal(candidate?.source.type, 'coupon-site');
    assert.equal(candidate?.source.domain, 'www.grabon.in');
    assert.ok(candidate?.source.snippet, 'the raw snippet is kept for auditing');
  });

  it('splits multi-offer text into separate candidates', () => {
    const candidates = extractCandidatesFromText(
      'Use code SHEIN800 for Rs.800 off Rs.1000. Use code NEW70 for 70% off up to Rs.700.',
      context(),
    );

    const codes = candidates.map((candidate) => candidate.code);
    assert.ok(codes.includes('SHEIN800'), 'first offer missing');
    assert.ok(codes.includes('NEW70'), 'second offer missing');
  });

  it('keeps promotions that have no code but do have terms', () => {
    const candidates = extractCandidatesFromText(
      'SHEIN India sale: up to 80% off on selected styles this week',
      context(),
    );

    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]?.code, undefined);
    assert.equal(candidates[0]?.isUpTo, true);
    assert.equal(candidates[0]?.discountType, 'sale');
  });

  it('ignores text with no discount information at all', () => {
    assert.deepEqual(
      extractCandidatesFromText('SHEIN India ships to most pin codes across the country', context()),
      [],
    );
  });

  it('requires a SHEIN mention when the page is not known to be about SHEIN', () => {
    const text = 'Use code MYNTRA500 to get Rs.500 off on Rs.2000';
    assert.deepEqual(extractCandidatesFromText(text, context({ pageIsAboutShein: false })), []);
    assert.equal(
      extractCandidatesFromText(text, context({ pageIsAboutShein: true })).length,
      1,
      'a SHEIN-specific page may omit the brand name in each snippet',
    );
  });

  it('deduplicates the same code repeated in one document', () => {
    const candidates = extractCandidatesFromText(
      'Use code SHEIN800 for Rs.800 off Rs.1000. Use code SHEIN800 for Rs.800 off Rs.1000.',
      context(),
    );
    assert.equal(candidates.length, 1);
  });
});

/**
 * These need a working HTML parser. They are skipped (not failed) when cheerio
 * is unavailable, e.g. before `npm install`.
 */
function cheerioAvailable(): boolean {
  try {
    cheerio.load('<p>ok</p>');
    return true;
  } catch {
    return false;
  }
}

describe(
  'extractCandidatesFromHtml',
  { skip: cheerioAvailable() ? false : 'cheerio is not installed' },
  () => {
    it('reads a coupon code from a copy-to-clipboard attribute', () => {
      const html = `
        <html><head><title>SHEIN Coupons</title></head><body>
          <div class="coupon-card" data-coupon-code="SHEIN800">
            <h3>Flat Rs.800 OFF on orders above Rs.1,000</h3>
            <p>New users only. Valid till 31 August 2026.</p>
          </div>
        </body></html>`;

      const candidates = extractCandidatesFromHtml(html, context());
      const match = candidates.find((candidate) => candidate.code === 'SHEIN800');

      assert.ok(match, 'expected the coupon card to be extracted');
      assert.equal(match?.discountType, 'flat');
      assert.equal(match?.discountValue, 800);
      assert.equal(match?.minimumOrder, 1000);
      assert.equal(match?.minimumOrderKnown, true);
      assert.equal(match?.newUsersOnly, true);
      assert.equal(match?.expiryDate?.getUTCDate(), 31);
    });

    it('reads a code from "use code" wording inside an offer card', () => {
      const html = `
        <html><body>
          <li class="offer-item">Use code NEW70 for 70% off up to Rs.700, min Rs.999</li>
        </body></html>`;

      const candidates = extractCandidatesFromHtml(html, context());
      const match = candidates.find((candidate) => candidate.code === 'NEW70');

      assert.ok(match);
      assert.equal(match?.discountType, 'percentage');
      assert.equal(match?.discountValue, 70);
      assert.equal(match?.maximumDiscount, 700);
      assert.equal(match?.isUpTo, false);
    });

    it('keeps a code-less sale banner as a sale, not a coupon', () => {
      const html = `
        <html><body>
          <li class="offer">UP TO 80% OFF SALE on SHEIN India styles</li>
        </body></html>`;

      const candidates = extractCandidatesFromHtml(html, context());
      const match = candidates.find((candidate) => candidate.discountType === 'sale');

      assert.ok(match);
      assert.equal(match?.code, undefined);
      assert.equal(match?.isUpTo, true);
    });

    it('reads structured JSON-LD offers when a site publishes them', () => {
      const html = `
        <html><body>
          <script type="application/ld+json">
            {"@type":"Offer","name":"SHEIN India","description":"Flat Rs.800 off on Rs.1000",
             "couponCode":"LDCODE800","validThrough":"2026-08-31"}
          </script>
        </body></html>`;

      const candidates = extractCandidatesFromHtml(html, context());
      const match = candidates.find((candidate) => candidate.code === 'LDCODE800');

      assert.ok(match, 'expected the JSON-LD offer to be extracted');
      assert.equal(match?.discountValue, 800);
      assert.equal(match?.expiryDate?.getUTCFullYear(), 2026);
    });

    it('returns nothing for a page with no offers', () => {
      const html = `
        <html><head><title>SHEIN India</title></head><body>
          <nav>Home</nav>
          <div class="content"><p>Discover the latest styles and trends.</p></div>
        </body></html>`;

      assert.deepEqual(extractCandidatesFromHtml(html, context()), []);
    });

    it('ignores unrelated offers on a page not known to be about SHEIN', () => {
      const html = `
        <html><body>
          <div class="coupon" data-coupon-code="MYNTRA500">Rs.500 off on Rs.2000 at Myntra</div>
        </body></html>`;

      assert.deepEqual(
        extractCandidatesFromHtml(html, context({ pageIsAboutShein: false })),
        [],
      );
    });

    it('survives malformed markup', () => {
      const html = '<div class="coupon"><span>Rs.800 off Rs.1000 SHEIN<div></span>';
      const candidates = extractCandidatesFromHtml(html, context());
      assert.ok(Array.isArray(candidates));
    });

    it('honours the candidate cap', () => {
      const cards = Array.from(
        { length: 30 },
        (_unused, index) =>
          `<div class="coupon" data-coupon-code="CODE${index}00">Rs.${index + 100} off Rs.1000</div>`,
      ).join('');

      const candidates = extractCandidatesFromHtml(`<body>${cards}</body>`, {
        ...context(),
        maxCandidates: 5,
      });
      assert.ok(candidates.length <= 5, `expected at most 5, got ${candidates.length}`);
    });
  },
);
