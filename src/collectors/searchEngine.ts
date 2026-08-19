import * as cheerio from 'cheerio';
import { config } from '../config';
import { extractCandidatesFromText } from '../extractors/couponExtractor';
import type { CouponCandidate } from '../types';
import { httpClient } from '../utils/httpClient';
import { describeError, logger } from '../utils/logger';
import { fetchPageCandidates } from './genericCouponPage';
import type { Collector, CollectorContext } from './types';

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  engine: string;
}

/** Queries rotate between cycles so no single query is hammered. */
let queryCursor = 0;
const QUERIES_PER_CYCLE = 6;

/**
 * Search-driven discovery.
 *
 * Preference order:
 *   1. Brave Search API   (BRAVE_SEARCH_API_KEY)
 *   2. SerpApi            (SERPAPI_KEY)
 *   3. DuckDuckGo HTML endpoint - used only if its robots.txt permits it
 *
 * Documented APIs are preferred precisely because scraping Google/Bing result
 * pages is against their terms; when no key is configured and robots.txt
 * disallows the fallback, the collector reports that it found nothing rather
 * than working around the restriction.
 */
export const searchEngineCollector: Collector = {
  name: 'searchEngine',
  sourceType: 'other',
  description: 'Public search results for freshness-focused SHEIN India coupon queries',
  enabled: true,

  async collect(context: CollectorContext): Promise<CouponCandidate[]> {
    const queries = selectQueries();
    const collected: CouponCandidate[] = [];
    const hits: SearchHit[] = [];

    for (const query of queries) {
      if (context.signal.aborted) break;
      const results = await runSearch(query, context);
      logger.debug('search executed', { query, results: results.length });
      hits.push(...results);
    }

    if (hits.length === 0) {
      logger.info('no search results available', {
        collector: 'searchEngine',
        hint: 'set BRAVE_SEARCH_API_KEY or SERPAPI_KEY for reliable search discovery',
      });
      return [];
    }

    // 1. Candidates straight from titles + snippets (cheap, no extra requests).
    for (const hit of hits) {
      const text = `${hit.title}. ${hit.snippet}`;
      const candidates = extractCandidatesFromText(text, {
        url: hit.url,
        sourceName: `search:${hit.engine}`,
        sourceType: 'other',
        now: context.now,
        pageIsAboutShein: /shein/i.test(text) || /shein/i.test(hit.url),
        maxCandidates: context.maxCandidates,
      });
      collected.push(...candidates);
    }

    // 2. Open a few of the most promising result pages in full.
    const pages = rankResultPages(hits).slice(0, config.searchResultPagesToFetch);
    for (const hit of pages) {
      if (context.signal.aborted) break;
      if (collected.length >= context.maxCandidates) break;

      const candidates = await fetchPageCandidates({
        url: hit.url,
        sourceName: `search:${hostLabel(hit.url)}`,
        sourceType: 'other',
        context,
        pageIsAboutShein: /shein/i.test(hit.title) || /shein/i.test(hit.url),
      });
      logger.debug('search result page scanned', { url: hit.url, found: candidates.length });
      collected.push(...candidates);
    }

    return collected.slice(0, context.maxCandidates);
  },
};

function selectQueries(): string[] {
  const all = config.searchQueries;
  if (all.length === 0) return [];
  const selected: string[] = [];
  for (let i = 0; i < Math.min(QUERIES_PER_CYCLE, all.length); i += 1) {
    selected.push(all[(queryCursor + i) % all.length] as string);
  }
  queryCursor = (queryCursor + QUERIES_PER_CYCLE) % all.length;
  return selected;
}

async function runSearch(query: string, context: CollectorContext): Promise<SearchHit[]> {
  try {
    if (config.braveApiKey) return await searchBrave(query, context);
    if (config.serpApiKey) return await searchSerpApi(query, context);
    return await searchDuckDuckGoHtml(query, context);
  } catch (error) {
    logger.warn('search failed', { query, reason: describeError(error) });
    return [];
  }
}

interface BraveResponse {
  web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
}

/** Brave Search API - documented, keyed, India-scoped, past-week freshness. */
async function searchBrave(query: string, context: CollectorContext): Promise<SearchHit[]> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(
    query,
  )}&country=IN&search_lang=en&count=20&freshness=pm`;

  const response = await httpClient.getJson<BraveResponse>(url, {
    signal: context.signal,
    ignoreRobots: true,
    headers: {
      'X-Subscription-Token': config.braveApiKey,
      Accept: 'application/json',
    },
  });

  return (response?.web?.results ?? [])
    .filter((result) => result.url)
    .map((result) => ({
      title: result.title ?? '',
      url: result.url as string,
      snippet: result.description ?? '',
      engine: 'brave',
    }));
}

interface SerpApiResponse {
  organic_results?: Array<{ title?: string; link?: string; snippet?: string }>;
}

/** SerpApi - documented aggregator, keyed. */
async function searchSerpApi(query: string, context: CollectorContext): Promise<SearchHit[]> {
  const url = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(
    query,
  )}&gl=in&hl=en&num=20&tbs=qdr:m&api_key=${encodeURIComponent(config.serpApiKey)}`;

  const response = await httpClient.getJson<SerpApiResponse>(url, {
    signal: context.signal,
    ignoreRobots: true,
  });

  return (response?.organic_results ?? [])
    .filter((result) => result.link)
    .map((result) => ({
      title: result.title ?? '',
      url: result.link as string,
      snippet: result.snippet ?? '',
      engine: 'serpapi',
    }));
}

/**
 * DuckDuckGo's no-JS HTML endpoint.
 * Goes through the normal client, so robots.txt decides whether it is used.
 */
async function searchDuckDuckGoHtml(query: string, context: CollectorContext): Promise<SearchHit[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=in-en`;
  const html = await httpClient.getText(url, { signal: context.signal });
  if (!html) return [];

  const hits: SearchHit[] = [];
  const $ = cheerio.load(html);

  for (const el of $('.result, .web-result').toArray().slice(0, 25)) {
    const node = $(el);
    const anchor = node.find('a.result__a').first();
    const href = anchor.attr('href');
    if (!href) continue;

    hits.push({
      title: (anchor.text() ?? '').trim(),
      url: decodeDuckDuckGoUrl(href),
      snippet: (node.find('.result__snippet').first().text() ?? '').trim(),
      engine: 'duckduckgo',
    });
  }

  return hits;
}

/** DuckDuckGo wraps outbound links in /l/?uddg=<encoded>. */
export function decodeDuckDuckGoUrl(href: string): string {
  try {
    const url = new URL(href, 'https://duckduckgo.com');
    const target = url.searchParams.get('uddg');
    return target ?? url.href;
  } catch {
    return href;
  }
}

/** Prefers SHEIN-specific coupon pages from known Indian deal domains. */
export function rankResultPages(hits: readonly SearchHit[]): SearchHit[] {
  const seen = new Set<string>();
  const scored = hits
    .filter((hit) => {
      if (!/^https?:\/\//i.test(hit.url)) return false;
      if (seen.has(hit.url)) return false;
      seen.add(hit.url);
      return true;
    })
    .map((hit) => {
      let score = 0;
      const haystack = `${hit.title} ${hit.snippet} ${hit.url}`.toLowerCase();
      if (/shein/.test(haystack)) score += 3;
      if (/coupon|promo ?code|offer/.test(haystack)) score += 2;
      if (/\u20b9|\brs\b|inr/.test(haystack)) score += 1;
      if (/india|\.in\b/.test(haystack)) score += 1;
      if (/shein\.(in|com)/.test(hit.url)) score += 3;
      if (/pinterest|facebook|instagram|youtube|twitter|x\.com/.test(hit.url)) score -= 3;
      return { hit, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.map((entry) => entry.hit);
}

function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'unknown';
  }
}
