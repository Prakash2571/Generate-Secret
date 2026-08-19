import type { OfferTerms } from '../types';

/**
 * Deterministic promotion text parser.
 *
 * Design rules (specification section 11):
 *  - "UP TO 80% OFF" is an upper bound, never a guaranteed 80% coupon
 *  - "₹800 off" is only tied to a ₹1,000 cart if a minimum order is stated
 *  - percentage caps ("70% off up to ₹700") are captured as maximumDiscount
 *  - sales, cashback and coupons are different things
 *
 * No LLM involved: everything here is regex/structure driven and testable.
 */

const CURRENCY = '\u20b9';

/** Normalises currency spellings and whitespace so one set of patterns works. */
export function normaliseText(input: string): string {
  return input
    .replace(/\u00a0/g, ' ')
    .replace(/[\u2018\u2019\u201c\u201d]/g, "'")
    .replace(/\u2013|\u2014/g, '-')
    .replace(/\bRs\.?\s?/gi, CURRENCY)
    .replace(/\bINR\s?/gi, CURRENCY)
    .replace(/\bRUPEES?\s?/gi, CURRENCY)
    .replace(/(\d)\s*\/-/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseAmount(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const cleaned = raw.replace(/,/g, '').trim();
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return undefined;
  const value = Number(cleaned);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  // Guard against parsing years, pin codes or product ids as money.
  if (value > 1_000_000) return undefined;
  return value;
}

const MONTHS: Record<string, number> = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};

/**
 * Parses an expiry date near expiry wording.
 * Accepts "31 Aug 2026", "Aug 31, 2026" and Indian-format dd/mm/yyyy.
 */
export function parseExpiryDate(text: string, now: Date = new Date()): Date | undefined {
  const normalised = normaliseText(text).toLowerCase();
  const trigger = /(valid|expires?|expiry|expiring|ends?|ending|till|until|last date|offer ends)/;
  if (!trigger.test(normalised)) return undefined;

  const monthNames = Object.keys(MONTHS).join('|');
  const candidates: Date[] = [];

  // 31 August 2026 / 31 Aug 26
  const dayFirst = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:of\\s*)?(${monthNames})[a-z]*,?\\s*(\\d{2,4})?`, 'g');
  for (const match of normalised.matchAll(dayFirst)) {
    const day = Number(match[1]);
    const month = MONTHS[match[2] as string];
    const year = resolveYear(match[3], now, month, day);
    if (month !== undefined) pushDate(candidates, year, month, day);
  }

  // August 31, 2026
  // The `(?!\d)` guard stops the day group from eating the first two digits of
  // a bare year ("August 2026" must not parse as the 20th).
  const monthFirst = new RegExp(
    `\\b(${monthNames})[a-z]*\\s+(\\d{1,2})(?!\\d)(?:st|nd|rd|th)?,?\\s*(\\d{2,4})?`,
    'g',
  );
  for (const match of normalised.matchAll(monthFirst)) {
    const month = MONTHS[match[1] as string];
    const day = Number(match[2]);
    const year = resolveYear(match[3], now, month, day);
    if (month !== undefined) pushDate(candidates, year, month, day);
  }

  // 31/08/2026 or 31-08-26 (day first, Indian convention)
  for (const match of normalised.matchAll(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\b/g)) {
    const day = Number(match[1]);
    const month = Number(match[2]) - 1;
    const rawYear = match[3] as string;
    const year = rawYear.length === 2 ? 2000 + Number(rawYear) : Number(rawYear);
    if (month >= 0 && month <= 11) pushDate(candidates, year, month, day);
  }

  const plausible = candidates.filter((date) => {
    const years = (date.getTime() - now.getTime()) / (365 * 86_400_000);
    return years > -2 && years < 3;
  });
  if (plausible.length === 0) return undefined;

  // Nearest future date wins; otherwise the most recent past date.
  const future = plausible.filter((date) => date.getTime() >= now.getTime());
  if (future.length > 0) {
    return future.reduce((best, date) => (date.getTime() < best.getTime() ? date : best));
  }
  return plausible.reduce((best, date) => (date.getTime() > best.getTime() ? date : best));
}

function resolveYear(raw: string | undefined, now: Date, month: number, day: number): number {
  if (raw) {
    const value = Number(raw);
    return raw.length === 2 ? 2000 + value : value;
  }
  // No year printed: assume the next occurrence of that date.
  const thisYear = now.getUTCFullYear();
  const guess = Date.UTC(thisYear, month, day, 23, 59, 59);
  return guess >= now.getTime() - 7 * 86_400_000 ? thisYear : thisYear + 1;
}

function pushDate(target: Date[], year: number, month: number, day: number): void {
  if (!Number.isFinite(year) || day < 1 || day > 31) return;
  // End of day: an offer valid "till 31 Aug" is usable during 31 Aug.
  const date = new Date(Date.UTC(year, month, day, 23, 59, 59));
  if (!Number.isNaN(date.getTime())) target.push(date);
}

const FLAG_PATTERNS = {
  newUsersOnly:
    /\b(new user|new users|new customer|new customers|new account|new shopper|newcomer|first[- ]time (?:user|customer|buyer)|first order|first purchase|1st order)\b/i,
  firstOrderOnly: /\b(first order|first purchase|1st order|first time order|on your first)\b/i,
  appOnly:
    /\b(app[- ]only|only on (?:the )?app|app exclusive|exclusively on (?:the )?app|in[- ]app only|mobile app only|via (?:the )?app|download the app)\b/i,
  selectedUsersOnly:
    /\b(select(?:ed)? users?|select(?:ed)? customers?|select(?:ed)? accounts?|user[- ]specific|account[- ]specific|for select members|targeted users?|not for all users)\b/i,
  selectedProductsOnly:
    /\b(select(?:ed)? (?:products?|items?|styles?|categories|categor(?:y|ies)|brands?|ranges?)|on select|marked products?|participating (?:products?|items?)|specific (?:products?|items?|categories))\b/i,
  existingUsersAllowed:
    /\b(existing users?|existing customers?|old users?|all users?|everyone|repeat customers?)\b/i,
  reportedExpired:
    /\b(expired|no longer (?:working|valid|available)|not working|has expired|offer ended|coupon (?:is )?dead)\b/i,
} as const;

export interface ParseOptions {
  now?: Date;
  /** Text already known to be a coupon description (skips sale heuristics). */
  assumeCoupon?: boolean;
}

/**
 * Converts free-form promotional text into structured, honest terms.
 */
export function parseOfferTerms(rawText: string, options: ParseOptions = {}): OfferTerms {
  const now = options.now ?? new Date();
  const text = normaliseText(rawText);
  const lower = text.toLowerCase();

  const terms: OfferTerms = {
    discountType: 'unknown',
    isUpTo: false,
    minimumOrderKnown: false,
  };

  // --- 1. Combined "₹800 off ₹1,000" form (discount + minimum in one) ------
  const combined = lower.match(
    new RegExp(
      `${CURRENCY}\\s*([\\d,]+)\\s*(?:off|discount)\\s*(?:on|above|over|for|upwards of|orders? (?:of|above|over))?\\s*${CURRENCY}\\s*([\\d,]+)`,
      'i',
    ),
  );
  if (combined) {
    const discount = parseAmount(combined[1]);
    const minimum = parseAmount(combined[2]);
    if (discount !== undefined && minimum !== undefined && minimum >= discount) {
      terms.discountType = 'flat';
      terms.discountValue = discount;
      terms.minimumOrder = minimum;
      terms.minimumOrderKnown = true;
    }
  }

  // --- 2. "up to" handling -------------------------------------------------
  const hasPercent = /\d{1,2}(?:\.\d)?\s*%/.test(lower);
  const upToMatches = [
    ...lower.matchAll(
      new RegExp(
        `\\bup\\s*to\\s*(?:flat\\s*)?(?:${CURRENCY}\\s*([\\d,]+)|(\\d{1,2}(?:\\.\\d)?)\\s*%)`,
        'gi',
      ),
    ),
  ];
  const maxPatterns = [
    ...lower.matchAll(
      new RegExp(
        `\\bmax(?:imum)?\\.?\\s*(?:discount|cashback|savings?)?\\s*(?:of|is|:)?\\s*${CURRENCY}\\s*([\\d,]+)`,
        'gi',
      ),
    ),
  ];

  for (const match of upToMatches) {
    const amount = parseAmount(match[1]);
    const percent = match[2] !== undefined ? Number(match[2]) : undefined;

    if (percent !== undefined && Number.isFinite(percent)) {
      // "up to 80% off" - an upper bound, never a guarantee.
      terms.isUpTo = true;
      if (terms.discountType === 'unknown') {
        terms.discountType = 'percentage';
        terms.discountValue = percent;
      }
    } else if (amount !== undefined) {
      if (hasPercent) {
        // "70% off up to ₹700" - the amount caps a percentage offer.
        terms.maximumDiscount = terms.maximumDiscount ?? amount;
      } else {
        // "up to ₹800 off" - the flat value itself is only an upper bound.
        terms.isUpTo = true;
        if (terms.discountValue === undefined) {
          terms.discountType = 'flat';
          terms.discountValue = amount;
        }
        terms.maximumDiscount = terms.maximumDiscount ?? amount;
      }
    }
  }

  for (const match of maxPatterns) {
    const amount = parseAmount(match[1]);
    if (amount !== undefined) terms.maximumDiscount = Math.min(terms.maximumDiscount ?? amount, amount);
  }

  // --- 3. Percentage offers ----------------------------------------------
  if (terms.discountType === 'unknown' || (terms.discountType === 'percentage' && terms.discountValue === undefined)) {
    const percentMatch = lower.match(/(?:flat\s*)?(\d{1,2}(?:\.\d)?)\s*%\s*(?:off|discount|savings?|less)?/i);
    if (percentMatch) {
      const percent = Number(percentMatch[1]);
      if (Number.isFinite(percent) && percent > 0 && percent <= 95) {
        terms.discountType = 'percentage';
        terms.discountValue = percent;
      }
    }
  }

  // --- 4. Flat amount offers ---------------------------------------------
  if (terms.discountType === 'unknown') {
    const flatMatch =
      lower.match(new RegExp(`(?:flat\\s*)?${CURRENCY}\\s*([\\d,]+)\\s*(?:off|discount)`, 'i')) ??
      lower.match(new RegExp(`(?:flat|save|get)\\s*${CURRENCY}\\s*([\\d,]+)`, 'i')) ??
      lower.match(/\b([\d,]{3,7})\s*(?:rupees\s*)?off\b/i);
    const amount = parseAmount(flatMatch?.[1]);
    if (amount !== undefined) {
      terms.discountType = 'flat';
      terms.discountValue = amount;
    }
  }

  // --- 5. Cashback is not a checkout discount ----------------------------
  if (/\bcash\s?back\b/i.test(lower)) {
    terms.discountType = 'cashback';
  }

  // --- 6. Sale wording without a coupon ----------------------------------
  const saleWording = /\b(sale|clearance|end of season|flash sale|mega sale|deals?|storewide|store wide)\b/i.test(
    lower,
  );
  if (
    !options.assumeCoupon &&
    saleWording &&
    terms.isUpTo &&
    (terms.discountType === 'percentage' || terms.discountType === 'unknown')
  ) {
    // "UP TO 80% OFF SALE" is a sale banner, not an 80% coupon.
    terms.discountType = 'sale';
  }

  // --- 7. Minimum order --------------------------------------------------
  if (!terms.minimumOrderKnown) {
    const minimumPatterns: RegExp[] = [
      new RegExp(
        `\\bmin(?:imum)?\\.?\\s*(?:order|purchase|spend|cart|bill|transaction|txn|value|amount|shopping)?\\s*(?:value|amount|of|is|:)?\\s*${CURRENCY}\\s*([\\d,]+)`,
        'i',
      ),
      new RegExp(
        `\\b(?:on|above|over|orders? (?:above|over|of)|purchase of|spend|shopping (?:of|above)|carts? (?:of|above))\\s*${CURRENCY}\\s*([\\d,]+)\\s*(?:or (?:more|above)|and above|\\+)?`,
        'i',
      ),
      new RegExp(`${CURRENCY}\\s*([\\d,]+)\\s*(?:or (?:more|above)|and above|\\+)`, 'i'),
    ];

    for (const pattern of minimumPatterns) {
      const match = lower.match(pattern);
      const amount = parseAmount(match?.[1]);
      if (amount !== undefined) {
        // A "minimum" below the flat discount itself is a misparse.
        if (terms.discountType === 'flat' && terms.discountValue !== undefined && amount < terms.discountValue) {
          continue;
        }
        terms.minimumOrder = amount;
        terms.minimumOrderKnown = true;
        break;
      }
    }
  }

  // --- 8. Restrictions and eligibility ----------------------------------
  if (FLAG_PATTERNS.newUsersOnly.test(lower)) terms.newUsersOnly = true;
  if (FLAG_PATTERNS.firstOrderOnly.test(lower)) terms.firstOrderOnly = true;
  if (FLAG_PATTERNS.appOnly.test(lower)) terms.appOnly = true;
  if (FLAG_PATTERNS.selectedUsersOnly.test(lower)) terms.selectedUsersOnly = true;
  if (FLAG_PATTERNS.selectedProductsOnly.test(lower)) terms.selectedProductsOnly = true;
  if (FLAG_PATTERNS.existingUsersAllowed.test(lower) && !terms.newUsersOnly) {
    terms.existingUsersAllowed = true;
  }
  if (FLAG_PATTERNS.reportedExpired.test(lower)) terms.reportedExpired = true;

  // --- 9. Expiry ---------------------------------------------------------
  const expiry = parseExpiryDate(text, now);
  if (expiry) terms.expiryDate = expiry;

  return terms;
}

/** True when the text plausibly concerns SHEIN in India. */
export function looksLikeSheinIndia(text: string): boolean {
  const lower = text.toLowerCase();
  if (!/\bshein\b/.test(lower)) return false;
  return (
    /\bindia\b|\bin\b\s*store|shein\.in|\u20b9|\brs\.?\b|\binr\b/i.test(lower) ||
    /\bindian\b/.test(lower)
  );
}

/** True when the offer text carries no usable discount information at all. */
export function isEmptyOffer(terms: OfferTerms): boolean {
  return terms.discountType === 'unknown' && terms.discountValue === undefined;
}
