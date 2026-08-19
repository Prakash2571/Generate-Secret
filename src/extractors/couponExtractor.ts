import * as cheerio from 'cheerio';
import { normaliseCode } from '../db/couponRepository';
import type { CouponCandidate, SourceType } from '../types';
import { safeDomain } from '../utils/concurrency';
import { isEmptyOffer, normaliseText, parseOfferTerms } from './promotionParser';

/** Tokens that look like codes but never are. */
const CODE_BLOCKLIST = new Set([
  'SHEIN', 'INDIA', 'OFFER', 'OFFERS', 'COUPON', 'COUPONS', 'CODE', 'CODES', 'PROMO',
  'DEAL', 'DEALS', 'SALE', 'SALES', 'DISCOUNT', 'DISCOUNTS', 'VOUCHER', 'CASHBACK',
  'FREE', 'SHIPPING', 'DELIVERY', 'NEW', 'USER', 'USERS', 'FIRST', 'ORDER', 'ORDERS',
  'TODAY', 'VERIFIED', 'WORKING', 'EXCLUSIVE', 'LIMITED', 'TERMS', 'CONDITIONS',
  'COPY', 'COPIED', 'SHOW', 'SHOP', 'NOW', 'CLICK', 'HERE', 'GET', 'SAVE', 'MORE',
  'HTTP', 'HTTPS', 'WWW', 'COM', 'HTML', 'JSON', 'NULL', 'TRUE', 'FALSE', 'UNDEFINED',
  'AND', 'THE', 'FOR', 'ALL', 'ONLY', 'MIN', 'MAX', 'UPTO', 'FLAT', 'OFF', 'APP',
  'ANDROID', 'IOS', 'AMAZON', 'FLIPKART', 'MYNTRA', 'AJIO', 'GRABON', 'COUPONDUNIA',
  'CASHKARO', 'DESIDIME', 'REDDIT', 'FASHION', 'WOMEN', 'MEN', 'KIDS', 'HOME',
  'CURATED', 'TRENDING', 'POPULAR', 'EXPIRED', 'ACTIVE', 'VALID', 'INVALID',
]);

/** Containers likely to hold one offer each. */
const OFFER_CONTAINER_SELECTORS = [
  '[data-coupon-code]',
  '[data-code]',
  '[data-clipboard-text]',
  '[class*="coupon" i]',
  '[class*="Coupon"]',
  '[class*="offer" i]',
  '[class*="Offer"]',
  '[class*="deal" i]',
  '[class*="promo" i]',
  '[class*="voucher" i]',
  '[id*="coupon" i]',
  '[id*="offer" i]',
  'article',
  'li',
].join(', ');

/** Attributes commonly used to carry a copyable coupon code. */
const CODE_ATTRIBUTES = [
  'data-coupon-code',
  'data-couponcode',
  'data-code',
  'data-clipboard-text',
  'data-coupon',
  'data-promo-code',
  'data-voucher',
  'value',
];

const MAX_NODES = 500;
const MAX_NODE_TEXT = 600;
const MIN_NODE_TEXT = 12;

export interface ExtractContext {
  url: string;
  sourceName: string;
  sourceType: SourceType;
  now?: Date;
  /** When false, each snippet must mention SHEIN itself. */
  pageIsAboutShein?: boolean;
  maxCandidates?: number;
}

/** True when a token is shaped like a real coupon code. */
export function isPlausibleCode(token: string, strongContext = false): boolean {
  const code = token.trim().toUpperCase();
  if (code.length < 4 || code.length > 24) return false;
  if (!/^[A-Z0-9][A-Z0-9_-]*$/.test(code)) return false;
  if (CODE_BLOCKLIST.has(code)) return false;
  // Pure numbers are prices, dates or ids - not codes.
  if (/^\d+$/.test(code)) return false;
  // Needs at least one letter.
  if (!/[A-Z]/.test(code)) return false;
  // Word-only tokens are accepted only from an explicit "use code X" context.
  if (!/\d/.test(code) && !strongContext) return false;
  // Reject obvious sentence fragments joined by hyphens.
  if (code.split(/[-_]/).length > 4) return false;
  return true;
}

/**
 * Finds a coupon code in text using explicit "use code" phrasing.
 * Only uppercase-looking tokens are accepted to avoid grabbing prose.
 */
export function extractCodeFromText(text: string): string | undefined {
  const patterns: RegExp[] = [
    /(?:use|apply|enter|with)\s+(?:the\s+)?(?:coupon|promo|discount|voucher)?\s*code\s*[:\-–"'“]*\s*([A-Za-z0-9][A-Za-z0-9_-]{3,23})\b/i,
    /(?:coupon|promo|discount|voucher)\s*code\s*[:\-–"'“]*\s*([A-Za-z0-9][A-Za-z0-9_-]{3,23})\b/i,
    /\bcode\s*[:\-–]\s*([A-Za-z0-9][A-Za-z0-9_-]{3,23})\b/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    const raw = match?.[1];
    if (!raw) continue;
    // The token must actually look like a code (mostly caps/digits), not prose.
    const uppercaseRatio = countUppercase(raw) / Math.max(1, countLetters(raw));
    if (countLetters(raw) > 0 && uppercaseRatio < 0.6) continue;
    if (isPlausibleCode(raw, true)) return normaliseCode(raw);
  }
  return undefined;
}

function countUppercase(value: string): number {
  return (value.match(/[A-Z]/g) ?? []).length;
}

function countLetters(value: string): number {
  return (value.match(/[A-Za-z]/g) ?? []).length;
}

/**
 * Extracts structured candidates from an HTML page.
 *
 * Strategy order: explicit code attributes -> offer containers -> embedded
 * JSON-LD -> whole-page "use code" scan. Structure first, prose last.
 */
export function extractCandidatesFromHtml(html: string, context: ExtractContext): CouponCandidate[] {
  const now = context.now ?? new Date();
  const $ = cheerio.load(html);

  $('script:not([type="application/ld+json"]), style, noscript, svg, iframe, header, footer, nav').remove();

  const pageTitle = normaliseText($('title').first().text() ?? '');
  const pageIsAboutShein =
    context.pageIsAboutShein ??
    (/shein/i.test(pageTitle) || /shein/i.test(context.url));

  const collected = new Map<string, CouponCandidate>();
  const limit = context.maxCandidates ?? 100;

  const push = (candidate: CouponCandidate): void => {
    if (collected.size >= limit) return;
    const key = candidate.code ?? `TXT:${candidate.rawText.slice(0, 80).toLowerCase()}`;
    const existing = collected.get(key);
    if (!existing) {
      collected.set(key, candidate);
      return;
    }
    // Prefer the entry with better-specified terms.
    if (informationScore(candidate) > informationScore(existing)) collected.set(key, candidate);
  };

  // --- 1. JSON-LD / embedded structured data ------------------------------
  for (const el of $('script[type="application/ld+json"]').toArray()) {
    const raw = $(el).text();
    if (!raw || raw.length > 200_000) continue;
    for (const candidate of extractFromJsonLd(raw, context, now, pageIsAboutShein)) {
      push(candidate);
    }
  }

  // --- 2. Offer containers -----------------------------------------------
  const nodes = $(OFFER_CONTAINER_SELECTORS).toArray().slice(0, MAX_NODES);
  for (const el of nodes) {
    const node = $(el);

    // Ignore containers that merely wrap other containers.
    const text = normaliseText(node.text() ?? '');
    if (text.length < MIN_NODE_TEXT || text.length > MAX_NODE_TEXT) continue;
    if (!pageIsAboutShein && !/shein/i.test(text)) continue;

    let code: string | undefined;
    for (const attribute of CODE_ATTRIBUTES) {
      const value = node.attr(attribute);
      if (value && isPlausibleCode(value, true)) {
        code = normaliseCode(value);
        break;
      }
    }
    if (!code) {
      const nested = node.find(CODE_ATTRIBUTES.map((attribute) => `[${attribute}]`).join(', ')).first();
      for (const attribute of CODE_ATTRIBUTES) {
        const value = nested.attr(attribute);
        if (value && isPlausibleCode(value, true)) {
          code = normaliseCode(value);
          break;
        }
      }
    }
    if (!code) code = extractCodeFromText(text);
    if (!code) code = extractCodeFromCodeElements($, node);

    const terms = parseOfferTerms(text, { now, assumeCoupon: Boolean(code) });
    if (!code && isEmptyOffer(terms)) continue;
    if (isEmptyOffer(terms) && !code) continue;

    push({
      ...terms,
      code,
      title: buildTitle(text),
      rawText: text,
      source: buildSource(context, now, text),
    });
  }

  // --- 3. Whole-page fallback for pages without obvious containers -------
  if (collected.size === 0) {
    const bodyText = normaliseText($('body').text() ?? '').slice(0, 20_000);
    if (pageIsAboutShein || /shein/i.test(bodyText)) {
      for (const candidate of extractCandidatesFromText(bodyText, context)) push(candidate);
    }
  }

  return [...collected.values()];
}

/** Looks for a code inside elements whose class/tag suggests a code chip. */
function extractCodeFromCodeElements(
  $: cheerio.CheerioAPI,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- cheerio node type varies by version
  node: cheerio.Cheerio<any>,
): string | undefined {
  const selectors = ['[class*="code" i]', '[class*="Code"]', 'code', 'strong', 'b', 'span'];
  for (const selector of selectors) {
    for (const el of node.find(selector).toArray().slice(0, 12)) {
      const value = normaliseText($(el).text() ?? '');
      if (!value || value.length > 24) continue;
      if (isPlausibleCode(value, false)) return normaliseCode(value);
    }
  }
  return undefined;
}

/**
 * Splits plain text into sentence-ish chunks and parses each one.
 * Used for search snippets, Reddit posts and pages without markup structure.
 */
export function extractCandidatesFromText(text: string, context: ExtractContext): CouponCandidate[] {
  const now = context.now ?? new Date();
  const normalised = normaliseText(text);
  const chunks = normalised
    .split(/(?<=[.!?\n])\s+|\s{2,}|\||•/)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length >= MIN_NODE_TEXT && chunk.length <= MAX_NODE_TEXT);

  const results: CouponCandidate[] = [];
  const seen = new Set<string>();

  for (const chunk of chunks.slice(0, 200)) {
    if (!(context.pageIsAboutShein ?? false) && !/shein/i.test(chunk)) continue;

    const code = extractCodeFromText(chunk);
    const terms = parseOfferTerms(chunk, { now, assumeCoupon: Boolean(code) });
    if (!code && isEmptyOffer(terms)) continue;

    const key = code ?? `TXT:${chunk.slice(0, 80).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    results.push({
      ...terms,
      code,
      title: buildTitle(chunk),
      rawText: chunk,
      source: buildSource(context, now, chunk),
    });
  }

  return results;
}

interface JsonLdNode {
  '@type'?: string | string[];
  name?: string;
  description?: string;
  couponCode?: string;
  discountCode?: string;
  priceValidUntil?: string;
  validThrough?: string;
  [key: string]: unknown;
}

/** Pulls offers out of schema.org JSON-LD blocks when sites publish them. */
function extractFromJsonLd(
  raw: string,
  context: ExtractContext,
  now: Date,
  pageIsAboutShein: boolean,
): CouponCandidate[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  const results: CouponCandidate[] = [];
  const queue: unknown[] = [parsed];
  let guard = 0;

  while (queue.length > 0 && guard < 2000) {
    guard += 1;
    const current = queue.shift();
    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }
    if (!current || typeof current !== 'object') continue;

    const node = current as JsonLdNode;
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') queue.push(value);
    }

    const code = node.couponCode ?? node.discountCode;
    const description = [node.name, node.description].filter(Boolean).join(' - ');
    if (!description && !code) continue;
    if (!pageIsAboutShein && !/shein/i.test(description)) continue;

    const text = normaliseText(description).slice(0, MAX_NODE_TEXT);
    const normalisedCode =
      code && isPlausibleCode(String(code), true) ? normaliseCode(String(code)) : undefined;

    const terms = parseOfferTerms(text, { now, assumeCoupon: Boolean(normalisedCode) });
    if (!normalisedCode && isEmptyOffer(terms)) continue;

    const validThrough = node.validThrough ?? node.priceValidUntil;
    if (typeof validThrough === 'string') {
      const parsedDate = new Date(validThrough);
      if (!Number.isNaN(parsedDate.getTime())) terms.expiryDate = parsedDate;
    }

    results.push({
      ...terms,
      code: normalisedCode,
      title: buildTitle(text),
      rawText: text || `coupon ${normalisedCode ?? ''}`.trim(),
      source: buildSource(context, now, text),
    });
  }

  return results;
}

function buildSource(context: ExtractContext, now: Date, snippet: string): CouponCandidate['source'] {
  return {
    name: context.sourceName,
    url: context.url,
    type: context.sourceType,
    domain: safeDomain(context.url),
    discoveredAt: now,
    lastSeenAt: now,
    snippet: snippet.slice(0, 400),
  };
}

function buildTitle(text: string): string {
  return text.length <= 120 ? text : `${text.slice(0, 117)}...`;
}

/** Ranks how well-specified a candidate is, for intra-page dedupe. */
function informationScore(candidate: CouponCandidate): number {
  let score = 0;
  if (candidate.code) score += 4;
  if (candidate.discountValue !== undefined) score += 2;
  if (candidate.minimumOrderKnown) score += 2;
  if (candidate.maximumDiscount !== undefined) score += 1;
  if (candidate.expiryDate) score += 1;
  if (candidate.discountType !== 'unknown') score += 1;
  return score;
}
