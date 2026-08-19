import { renderPage } from '../browser/renderPage';
import { config } from '../config';
import { extractCandidatesFromHtml } from '../extractors/couponExtractor';
import type { CouponCandidate, SourceType } from '../types';
import { describeError, logger } from '../utils/logger';
import { httpClient } from '../utils/httpClient';
import type { Collector, CollectorContext } from './types';

export interface PageFetchOptions {
  url: string;
  sourceName: string;
  sourceType: SourceType;
  context: CollectorContext;
  /** Whole page is known to be about SHEIN (relaxes the per-snippet check). */
  pageIsAboutShein?: boolean;
  /** Render with Chromium when plain HTTP returns nothing useful. */
  browserFallback?: boolean;
  /** Selector to wait for when rendering. */
  waitForSelector?: string;
}

/**
 * Fetches one public page and extracts candidates.
 * Always resolves - a failing page yields an empty array plus a log line.
 */
export async function fetchPageCandidates(options: PageFetchOptions): Promise<CouponCandidate[]> {
  const { url, sourceName, sourceType, context } = options;
  if (context.signal.aborted) return [];

  const extract = (html: string): CouponCandidate[] =>
    extractCandidatesFromHtml(html, {
      url,
      sourceName,
      sourceType,
      now: context.now,
      pageIsAboutShein: options.pageIsAboutShein,
      maxCandidates: context.maxCandidates,
    });

  let candidates: CouponCandidate[] = [];

  const html = await httpClient.getText(url, { signal: context.signal });
  if (html) {
    try {
      candidates = extract(html);
    } catch (error) {
      logger.warn('extraction failed', { url, reason: describeError(error) });
    }
  }

  // Many coupon sites render their offer list client-side.
  const shouldRender =
    (options.browserFallback ?? true) && candidates.length === 0 && !context.signal.aborted;

  if (shouldRender) {
    const rendered = await renderPage(url, {
      signal: context.signal,
      waitForSelector: options.waitForSelector,
    });
    if (rendered) {
      try {
        candidates = extract(rendered);
        if (candidates.length > 0) {
          logger.debug('candidates recovered via browser render', {
            url,
            count: candidates.length,
          });
        }
      } catch (error) {
        logger.warn('extraction failed on rendered page', {
          url,
          reason: describeError(error),
        });
      }
    }
  }

  return candidates;
}

export interface CouponSiteSpec {
  name: string;
  sourceType: SourceType;
  description: string;
  urls: string[];
  pageIsAboutShein?: boolean;
  browserFallback?: boolean;
  waitForSelector?: string;
  enabled?: boolean;
}

/**
 * Builds a collector for a public coupon/deal site.
 *
 * Adding a new source is just a matter of calling this with its SHEIN URLs -
 * see README "Adding collectors".
 */
export function createCouponSiteCollector(spec: CouponSiteSpec): Collector {
  return {
    name: spec.name,
    sourceType: spec.sourceType,
    description: spec.description,
    enabled: spec.enabled ?? true,

    async collect(context: CollectorContext): Promise<CouponCandidate[]> {
      const collected: CouponCandidate[] = [];

      for (const url of spec.urls) {
        if (context.signal.aborted) break;
        if (collected.length >= context.maxCandidates) break;

        const candidates = await fetchPageCandidates({
          url,
          sourceName: spec.name,
          sourceType: spec.sourceType,
          context,
          pageIsAboutShein: spec.pageIsAboutShein ?? true,
          browserFallback: spec.browserFallback,
          waitForSelector: spec.waitForSelector,
        });

        logger.debug('page scanned', { collector: spec.name, url, found: candidates.length });
        collected.push(...candidates);
      }

      return collected.slice(0, context.maxCandidates);
    },
  };
}

/**
 * Scans any additional public pages supplied through EXTRA_SOURCE_URLS.
 * Lets you add a source without touching the code.
 */
export const genericCollector: Collector = {
  name: 'generic',
  sourceType: 'other',
  description: 'Any extra public coupon pages listed in EXTRA_SOURCE_URLS',
  enabled: config.extraSourceUrls.length > 0,

  async collect(context: CollectorContext): Promise<CouponCandidate[]> {
    const collected: CouponCandidate[] = [];

    for (const url of config.extraSourceUrls) {
      if (context.signal.aborted) break;
      const candidates = await fetchPageCandidates({
        url,
        sourceName: `generic:${hostLabel(url)}`,
        sourceType: 'other',
        context,
        // Unknown pages must mention SHEIN in the snippet itself.
        pageIsAboutShein: false,
      });
      collected.push(...candidates);
    }

    return collected.slice(0, context.maxCandidates);
  },
};

function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'unknown';
  }
}
