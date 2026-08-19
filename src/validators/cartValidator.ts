import type { Page } from 'playwright';
import { browserManager } from '../browser/BrowserManager';
import { config } from '../config';
import { parseAmount, normaliseText } from '../extractors/promotionParser';
import type { OfferTerms } from '../types';
import { describeError, logger } from '../utils/logger';
import { detectChallenge } from '../utils/rawFetch';
import { robotsCache } from '../utils/robots';
import { sleep } from '../utils/time';

/**
 * Outcome of interacting with the normal customer-facing coupon field.
 *
 *  accepted     - the site applied the coupon
 *  rejected     - the site explicitly refused the code
 *  conditional  - the code is recognised but conditions are unmet (reveals terms)
 *  blocked      - login / OTP / CAPTCHA / anti-bot in the way (never bypassed)
 *  unavailable  - no coupon field reachable without placing items or signing in
 */
export type CartVerdict = 'accepted' | 'rejected' | 'conditional' | 'blocked' | 'unavailable';

export interface CartValidationResult {
  verdict: CartVerdict;
  detail: string;
  observedTerms?: Partial<OfferTerms>;
}

/** Public, non-checkout pages where a coupon field may legitimately appear. */
const CART_URLS = ['https://www.shein.in/cart', 'https://in.shein.com/cart'];

const COUPON_INPUT_SELECTORS = [
  'input[placeholder*="coupon" i]',
  'input[placeholder*="promo" i]',
  'input[placeholder*="discount" i]',
  'input[name*="coupon" i]',
  'input[id*="coupon" i]',
  'input[aria-label*="coupon" i]',
  '[class*="coupon" i] input[type="text"]',
  '[class*="promo" i] input[type="text"]',
];

const APPLY_BUTTON_SELECTORS = [
  'button:has-text("Apply")',
  'button:has-text("APPLY")',
  '[role="button"]:has-text("Apply")',
  'button[class*="apply" i]',
  '[class*="coupon" i] button',
];

const SUCCESS_PATTERNS = [
  /coupon\s+applied/i,
  /promo(?:tion)?\s+code\s+applied/i,
  /discount\s+applied/i,
  /applied\s+successfully/i,
  /you\s+saved/i,
  /coupon\s+discount/i,
];

const REJECTION_PATTERNS = [
  /invalid\s+(?:coupon|code|promo)/i,
  /coupon\s+(?:is\s+)?(?:invalid|expired|not\s+valid)/i,
  /code\s+(?:is\s+)?(?:invalid|expired|incorrect|not\s+found)/i,
  /does\s+not\s+exist/i,
  /no\s+longer\s+(?:valid|available)/i,
  /cannot\s+be\s+used/i,
  /not\s+applicable/i,
  /已过期|不可用/,
];

const CONDITIONAL_PATTERNS = [
  /min(?:imum)?\s+(?:order|spend|purchase|amount)/i,
  /add\s+(?:more\s+)?items?/i,
  /not\s+eligible/i,
  /only\s+(?:for|valid\s+for)\s+(?:new|first|selected)/i,
  /selected\s+(?:items?|products?)/i,
  /spend\s+\u20b9?\s*[\d,]+\s+more/i,
];

const BLOCKED_PATTERNS = [
  /sign\s?in|log\s?in|login|register/i,
  /\botp\b|verification\s+code/i,
  /captcha|are\s+you\s+a\s+human|verify\s+you\s+are\s+human/i,
  /unusual\s+traffic|access\s+denied|blocked/i,
];

/**
 * Attempts validation exactly as a shopper would: open the public cart page,
 * type the code into the standard coupon box, press Apply, read the message.
 *
 * Hard limits, by design:
 *  - never signs in, never creates an account, never requests an OTP
 *  - never solves or evades a CAPTCHA / anti-bot challenge
 *  - never adds payment details and never places an order
 *  - never navigates to checkout (blocked at the BrowserManager level)
 *
 * When anything of that kind stands in the way the verdict is `blocked`, which
 * the caller turns into `manual_validation_required`.
 */
export async function validateInCart(
  code: string,
  options: { signal: AbortSignal },
): Promise<CartValidationResult> {
  if (!config.enableCartValidation) {
    return { verdict: 'unavailable', detail: 'cart validation disabled by configuration' };
  }
  if (!browserManager.isAvailable || options.signal.aborted) {
    return { verdict: 'unavailable', detail: 'browser unavailable' };
  }

  for (const url of CART_URLS) {
    if (options.signal.aborted) break;

    const allowed = await robotsCache.isAllowed(url, options.signal);
    if (!allowed) {
      logger.debug('cart validation skipped, disallowed by robots.txt', { url });
      continue;
    }

    try {
      const result = await browserManager.withPage(
        async (page) => attemptOnPage(page, url, code, options.signal),
        { label: `cart:${code}` },
      );
      // Keep trying the next domain only when this one gave us nothing.
      if (result.verdict !== 'unavailable') return result;
    } catch (error) {
      logger.debug('cart validation attempt failed', {
        url,
        code,
        reason: describeError(error),
      });
    }
  }

  return {
    verdict: 'unavailable',
    detail:
      'no customer-facing coupon field could be reached without signing in or building a cart',
  };
}

async function attemptOnPage(
  page: Page,
  url: string,
  code: string,
  signal: AbortSignal,
): Promise<CartValidationResult> {
  await browserManager.goto(page, url, 'domcontentloaded');
  await sleep(2000, signal);

  const initialHtml = await page.content();
  const challenge = detectChallenge(initialHtml, 200);
  if (challenge) {
    return {
      verdict: 'blocked',
      detail: `anti-bot challenge encountered (${challenge}) - not bypassed`,
    };
  }

  if (/\/user\/auth\/login|\/login/i.test(page.url())) {
    return { verdict: 'blocked', detail: 'site redirected to a login page' };
  }

  const input = await findFirstVisible(page, COUPON_INPUT_SELECTORS);
  if (!input) {
    const bodyText = normaliseText(await safeText(page));
    if (BLOCKED_PATTERNS.some((pattern) => pattern.test(bodyText.slice(0, 4000)))) {
      return {
        verdict: 'blocked',
        detail: 'coupon field requires sign-in / verification, which is never attempted',
      };
    }
    return {
      verdict: 'unavailable',
      detail: 'no coupon field present on the public cart page (cart is empty)',
    };
  }

  await input.fill(code, { timeout: 5000 });
  const before = normaliseText(await safeText(page));

  const button = await findFirstVisible(page, APPLY_BUTTON_SELECTORS);
  if (button) {
    await button.click({ timeout: 5000 }).catch(() => undefined);
  } else {
    await input.press('Enter').catch(() => undefined);
  }

  // Give the site time to answer, then read the difference.
  await sleep(3500, signal);
  const after = normaliseText(await safeText(page));
  const message = extractNewText(before, after) || after;

  return classifyResponse(message, code);
}

/** Classifies the site's response into a verdict. Exported for tests/reuse. */
export function classifyResponse(message: string, code: string): CartValidationResult {
  const haystack = message.slice(0, 6000);

  if (BLOCKED_PATTERNS.some((pattern) => pattern.test(haystack))) {
    return {
      verdict: 'blocked',
      detail: 'sign-in / OTP / verification requested after applying the code',
    };
  }

  if (REJECTION_PATTERNS.some((pattern) => pattern.test(haystack))) {
    return { verdict: 'rejected', detail: `coupon field rejected ${code}` };
  }

  if (CONDITIONAL_PATTERNS.some((pattern) => pattern.test(haystack))) {
    return {
      verdict: 'conditional',
      detail: `code recognised but conditions unmet: ${summarise(haystack)}`,
      observedTerms: readTermsFromMessage(haystack),
    };
  }

  if (SUCCESS_PATTERNS.some((pattern) => pattern.test(haystack))) {
    return {
      verdict: 'accepted',
      detail: `coupon field accepted ${code}: ${summarise(haystack)}`,
      observedTerms: readTermsFromMessage(haystack),
    };
  }

  return {
    verdict: 'unavailable',
    detail: 'response could not be interpreted with confidence',
  };
}

/** Pulls a minimum order or discount amount out of the site's own message. */
export function readTermsFromMessage(message: string): Partial<OfferTerms> | undefined {
  const terms: Partial<OfferTerms> = {};

  const minimum = message.match(
    /min(?:imum)?\s*(?:order|spend|purchase|amount|cart)?\s*(?:value|of|is|:)?\s*\u20b9?\s*([\d,]+)/i,
  );
  const minimumValue = parseAmount(minimum?.[1]);
  if (minimumValue !== undefined) {
    terms.minimumOrder = minimumValue;
    terms.minimumOrderKnown = true;
  }

  const saved = message.match(/(?:you\s+saved|discount|saving)\s*[:\-]?\s*\u20b9\s*([\d,]+)/i);
  const savedValue = parseAmount(saved?.[1]);
  if (savedValue !== undefined) {
    terms.discountValue = savedValue;
    terms.discountType = 'flat';
  }

  return Object.keys(terms).length > 0 ? terms : undefined;
}

async function findFirstVisible(
  page: Page,
  selectors: readonly string[],
): Promise<ReturnType<Page['locator']> | null> {
  for (const selector of selectors) {
    try {
      const locator = page.locator(selector).first();
      if ((await locator.count()) === 0) continue;
      if (await locator.isVisible({ timeout: 1500 })) return locator;
    } catch {
      // Selector unsupported or detached - try the next one.
    }
  }
  return null;
}

async function safeText(page: Page): Promise<string> {
  try {
    return (await page.locator('body').innerText({ timeout: 5000 })) ?? '';
  } catch {
    try {
      return await page.content();
    } catch {
      return '';
    }
  }
}

/** Returns text present after the interaction but not before it. */
export function extractNewText(before: string, after: string): string {
  if (!before) return after;
  if (after.startsWith(before)) return after.slice(before.length);

  const beforeLines = new Set(before.split(/\n|\.\s/).map((line) => line.trim()));
  return after
    .split(/\n|\.\s/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !beforeLines.has(line))
    .join(' ');
}

function summarise(message: string): string {
  return message.replace(/\s+/g, ' ').trim().slice(0, 200);
}
