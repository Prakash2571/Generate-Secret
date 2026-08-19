import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { config } from '../config';
import { describeError, logger } from '../utils/logger';
import { shutdownManager } from '../utils/shutdown';

/**
 * URL fragments that must never be opened by automation.
 *
 * The scanner reads public pages and (at most) types a coupon into a normal
 * coupon field. It must never approach order placement or payment.
 */
const FORBIDDEN_URL_PATTERNS: RegExp[] = [
  /\/checkout/i,
  /\/check_?out/i,
  /\/payment/i,
  /\/pay(?:ment)?\b/i,
  /\/order\/(?:submit|create|place|confirm)/i,
  /place_?order/i,
  /\/purchase/i,
  /razorpay|payu|billdesk|cashfree|stripe\.com|paypal\.com/i,
];

/** Resource types we never need; blocking them keeps the crawl light. */
const BLOCKED_RESOURCE_TYPES = new Set(['image', 'media', 'font']);

export class UnsafeNavigationError extends Error {
  constructor(url: string) {
    super(`refusing to navigate to a checkout/payment URL: ${url}`);
    this.name = 'UnsafeNavigationError';
  }
}

export function assertSafeUrl(url: string): void {
  if (FORBIDDEN_URL_PATTERNS.some((pattern) => pattern.test(url))) {
    throw new UnsafeNavigationError(url);
  }
}

export interface PageOptions {
  /** Extra label used in logs. */
  label?: string;
  /** Block image/media/font requests (default true). */
  lightweight?: boolean;
}

/**
 * Owns a single shared Chromium instance.
 *
 * One browser process, one context per task, everything tracked so graceful
 * shutdown can guarantee no orphaned Chromium processes are left behind.
 */
export class BrowserManager {
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;
  private readonly contexts = new Set<BrowserContext>();
  private closed = false;
  private pagesOpened = 0;

  get isAvailable(): boolean {
    return !this.closed && !shutdownManager.isShuttingDown;
  }

  get stats(): { launched: boolean; openContexts: number; pagesOpened: number } {
    return {
      launched: this.browser !== null,
      openContexts: this.contexts.size,
      pagesOpened: this.pagesOpened,
    };
  }

  /** Launches on first use; subsequent callers reuse the same browser. */
  async getBrowser(): Promise<Browser> {
    if (this.closed) throw new Error('BrowserManager is closed');
    if (this.browser && this.browser.isConnected()) return this.browser;
    if (this.launching) return this.launching;

    this.launching = chromium
      .launch({
        headless: config.headless,
        timeout: config.browserTimeoutMs,
        args: [
          // Required when running as an unprivileged user inside a container.
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-background-networking',
        ],
      })
      .then((browser) => {
        this.browser = browser;
        browser.on('disconnected', () => {
          if (this.browser === browser) this.browser = null;
        });
        logger.info('chromium launched', { headless: config.headless });
        return browser;
      })
      .finally(() => {
        this.launching = null;
      });

    return this.launching;
  }

  /**
   * Runs `task` with a fresh, isolated context+page and always tears them down.
   * A fresh context per task means no cookie/session bleed between checks.
   */
  async withPage<T>(task: (page: Page) => Promise<T>, options: PageOptions = {}): Promise<T> {
    if (!this.isAvailable) {
      throw new Error('browser unavailable (shutting down)');
    }

    const browser = await this.getBrowser();
    const context = await browser.newContext({
      userAgent: config.userAgent,
      locale: 'en-IN',
      timezoneId: 'Asia/Kolkata',
      viewport: { width: 1366, height: 900 },
      // India-facing pages only; no geolocation/permission grants.
      javaScriptEnabled: true,
    });
    this.contexts.add(context);
    context.setDefaultTimeout(config.browserTimeoutMs);
    context.setDefaultNavigationTimeout(config.browserTimeoutMs);

    try {
      const page = await context.newPage();
      this.pagesOpened += 1;

      await page.route('**/*', async (route) => {
        const request = route.request();
        const url = request.url();

        // Hard guard: never let the page reach a payment/checkout endpoint.
        if (FORBIDDEN_URL_PATTERNS.some((pattern) => pattern.test(url))) {
          logger.debug('blocked forbidden request', { url: url.slice(0, 160) });
          await route.abort().catch(() => undefined);
          return;
        }
        if (options.lightweight !== false && BLOCKED_RESOURCE_TYPES.has(request.resourceType())) {
          await route.abort().catch(() => undefined);
          return;
        }
        await route.continue().catch(() => undefined);
      });

      return await task(page);
    } finally {
      this.contexts.delete(context);
      await context.close().catch((error) => {
        logger.debug('context close failed', { reason: describeError(error) });
      });
    }
  }

  /** Navigates safely: refuses forbidden URLs before touching the network. */
  async goto(page: Page, url: string, waitUntil: 'domcontentloaded' | 'load' = 'domcontentloaded'): Promise<void> {
    assertSafeUrl(url);
    await page.goto(url, { waitUntil, timeout: config.browserTimeoutMs });
  }

  /** Closes every context and the browser. Safe to call repeatedly. */
  async close(): Promise<void> {
    this.closed = true;
    const contexts = [...this.contexts];
    this.contexts.clear();

    for (const context of contexts) {
      await context.close().catch(() => undefined);
    }

    if (this.browser) {
      const browser = this.browser;
      this.browser = null;
      try {
        await browser.close();
        logger.info('chromium closed', { contextsClosed: contexts.length });
      } catch (error) {
        logger.warn('failed to close chromium cleanly', { reason: describeError(error) });
      }
    }
  }
}

export const browserManager = new BrowserManager();
