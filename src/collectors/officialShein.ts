import * as cheerio from 'cheerio';
import { renderPage } from '../browser/renderPage';
import { extractCandidatesFromHtml } from '../extractors/couponExtractor';
import type { CouponCandidate } from '../types';
import { httpClient } from '../utils/httpClient';
import { describeError, logger } from '../utils/logger';
import type { Collector, CollectorContext } from './types';

/**
 * Public, customer-facing SHEIN India entry points.
 * 404s are expected as SHEIN reorganises campaign paths; failures are skipped.
 */
const OFFICIAL_URLS = [
  'https://www.shein.in/',
  'https://www.shein.in/coupon-a-1035.html',
  'https://www.shein.in/promotion',
  'https://www.shein.in/campaign/new-in',
  'https://in.shein.com/',
  'https://in.shein.com/coupon-a-1035.html',
  'https://in.shein.com/promotion',
];

/** Anchor text/href hints that suggest a promotional landing page. */
const PROMO_LINK_HINT = /coupon|promo|offer|deal|sale|discount|new[-_ ]?user|campaign/i;
const MAX_DISCOVERED_LINKS = 4;

/**
 * Official SHEIN India collector.
 *
 * Anything found here is `official` evidence and outranks third-party claims
 * (specification sections 13 and 29). SHEIN is heavily client-rendered, so the
 * collector falls back to Chromium; if an anti-bot challenge appears it stops
 * rather than trying to get around it.
 */
export const officialSheinCollector: Collector = {
  name: 'officialShein',
  sourceType: 'official',
  description: 'Official SHEIN India storefront and promotional pages',
  enabled: true,

  async collect(context: CollectorContext): Promise<CouponCandidate[]> {
    const collected: CouponCandidate[] = [];
    const visited = new Set<string>();
    const queue = [...OFFICIAL_URLS];
    let discoveredLinks = 0;

    logger.tag('COLLECT', `officialShein: scanning ${queue.length} official page(s)`);

    while (queue.length > 0) {
      if (context.signal.aborted) break;
      if (collected.length >= context.maxCandidates) break;

      const url = queue.shift() as string;
      if (visited.has(url)) continue;
      visited.add(url);

      const html = await loadOfficialPage(url, context);
      if (!html) continue;

      try {
        const candidates = extractCandidatesFromHtml(html, {
          url,
          sourceName: 'officialShein',
          sourceType: 'official',
          now: context.now,
          pageIsAboutShein: true,
          maxCandidates: context.maxCandidates,
        });
        logger.tag('FETCH', `officialShein: ${candidates.length} candidate offers from ${url}`);
        collected.push(...candidates);
      } catch (error) {
        logger.warn('official page extraction failed', { url, reason: describeError(error) });
      }

      // Follow a small number of on-site promotional links.
      if (discoveredLinks < MAX_DISCOVERED_LINKS) {
        for (const link of findPromoLinks(html, url)) {
          if (discoveredLinks >= MAX_DISCOVERED_LINKS) break;
          if (visited.has(link) || queue.includes(link)) continue;
          queue.push(link);
          discoveredLinks += 1;
        }
      }
    }

    return collected.slice(0, context.maxCandidates);
  },
};

/** Plain HTTP first, Chromium second (SHEIN renders offers client-side). */
async function loadOfficialPage(url: string, context: CollectorContext): Promise<string | null> {
  logger.tag('FETCH', `officialShein: requesting ${url}`);
  const direct = await httpClient.getText(url, { signal: context.signal });
  if (direct && /coupon|discount|% off|\u20b9/i.test(direct)) return direct;

  const rendered = await renderPage(url, {
    signal: context.signal,
    settleMs: 2500,
  });
  return rendered ?? direct;
}

/** Collects same-site promotional links worth a look. */
export function findPromoLinks(html: string, baseUrl: string): string[] {
  const links: string[] = [];
  try {
    const $ = cheerio.load(html);
    const base = new URL(baseUrl);

    for (const el of $('a[href]').toArray().slice(0, 400)) {
      const node = $(el);
      const href = node.attr('href');
      if (!href) continue;

      const text = (node.text() ?? '').trim();
      if (!PROMO_LINK_HINT.test(href) && !PROMO_LINK_HINT.test(text)) continue;

      let resolved: URL;
      try {
        resolved = new URL(href, base);
      } catch {
        continue;
      }
      if (resolved.protocol !== 'https:') continue;
      // Stay on SHEIN's own domains.
      if (!/(^|\.)shein\.(in|com)$/i.test(resolved.hostname)) continue;
      resolved.hash = '';
      links.push(resolved.href);
    }
  } catch {
    return [];
  }
  return [...new Set(links)];
}
