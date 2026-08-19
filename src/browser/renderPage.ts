import { config } from '../config';
import { describeError, logger } from '../utils/logger';
import { detectChallenge } from '../utils/rawFetch';
import { robotsCache } from '../utils/robots';
import { sleep } from '../utils/time';
import { browserManager } from './BrowserManager';

export interface RenderOptions {
  signal?: AbortSignal;
  /** Optional selector to wait for before reading the DOM. */
  waitForSelector?: string;
  /** Extra settle time for client-rendered offer lists. */
  settleMs?: number;
}

/**
 * Renders a JS-heavy public page and returns its HTML.
 *
 * Returns null (never throws) when the page is unavailable, disallowed by
 * robots.txt, or protected by an anti-bot challenge - challenges are reported,
 * never circumvented.
 */
export async function renderPage(url: string, options: RenderOptions = {}): Promise<string | null> {
  if (!config.enableBrowserFallback) return null;
  if (!browserManager.isAvailable) return null;
  if (options.signal?.aborted) return null;

  const allowed = await robotsCache.isAllowed(url, options.signal);
  if (!allowed) {
    logger.info('skipping browser render disallowed by robots.txt', { url });
    return null;
  }

  try {
    return await browserManager.withPage(async (page) => {
      await browserManager.goto(page, url, 'domcontentloaded');

      if (options.waitForSelector) {
        await page
          .waitForSelector(options.waitForSelector, { timeout: 8000 })
          .catch(() => undefined);
      }
      await sleep(options.settleMs ?? 1500, options.signal);

      const html = await page.content();
      const challenge = detectChallenge(html, 200);
      if (challenge) {
        logger.warn('anti-bot challenge on rendered page (not bypassed)', {
          url,
          reason: challenge,
        });
        return null;
      }
      return html;
    });
  } catch (error) {
    logger.debug('browser render failed', { url, reason: describeError(error) });
    return null;
  }
}
