import { config } from '../config';
import { extractCandidatesFromText } from '../extractors/couponExtractor';
import type { CouponCandidate } from '../types';
import { httpClient } from '../utils/httpClient';
import { describeError, logger } from '../utils/logger';
import { rawFetch } from '../utils/rawFetch';
import type { Collector, CollectorContext } from './types';

const SEARCH_TERMS = [
  'shein india coupon',
  'shein coupon code india',
  'shein 800 off',
  'shein new user offer india',
];

interface RedditListing {
  data?: {
    children?: Array<{
      data?: {
        title?: string;
        selftext?: string;
        permalink?: string;
        subreddit?: string;
        created_utc?: number;
        url?: string;
      };
    }>;
  };
}

interface TokenCache {
  token: string;
  expiresAt: number;
}

let tokenCache: TokenCache | null = null;

/**
 * Reddit collector.
 *
 * Uses the official OAuth API when REDDIT_CLIENT_ID/REDDIT_CLIENT_SECRET are
 * configured (the sanctioned route). Without credentials it tries the public
 * .json endpoint, which only proceeds if Reddit's robots.txt allows it.
 *
 * Reddit posts are `community` evidence: useful for freshness signals, never
 * sufficient on their own to call a coupon valid.
 */
export const redditCollector: Collector = {
  name: 'reddit',
  sourceType: 'community',
  description: 'Public Reddit posts mentioning SHEIN India coupons',
  enabled: true,

  async collect(context: CollectorContext): Promise<CouponCandidate[]> {
    const collected: CouponCandidate[] = [];

    for (const term of SEARCH_TERMS) {
      if (context.signal.aborted) break;
      if (collected.length >= context.maxCandidates) break;

      const listing = await search(term, context);
      if (!listing) continue;

      for (const child of listing.data?.children ?? []) {
        const post = child.data;
        if (!post) continue;

        const text = `${post.title ?? ''}. ${(post.selftext ?? '').slice(0, 2000)}`;
        if (!/shein/i.test(text)) continue;

        const url = post.permalink
          ? `https://www.reddit.com${post.permalink}`
          : (post.url ?? 'https://www.reddit.com/');

        const postedAt = post.created_utc ? new Date(post.created_utc * 1000) : context.now;

        const candidates = extractCandidatesFromText(text, {
          url,
          sourceName: `reddit:${post.subreddit ?? 'unknown'}`,
          sourceType: 'community',
          now: context.now,
          pageIsAboutShein: true,
          maxCandidates: context.maxCandidates,
        });

        // Reflect when the post was actually written, not when we read it.
        for (const candidate of candidates) {
          candidate.source.discoveredAt = postedAt;
        }
        collected.push(...candidates);
      }
    }

    return collected.slice(0, context.maxCandidates);
  },
};

async function search(term: string, context: CollectorContext): Promise<RedditListing | null> {
  const token = await getAppToken(context);

  if (token) {
    const url = `https://oauth.reddit.com/search?q=${encodeURIComponent(
      term,
    )}&sort=new&limit=25&t=month&raw_json=1`;
    return httpClient.getJson<RedditListing>(url, {
      signal: context.signal,
      ignoreRobots: true,
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  // No credentials: public endpoint, robots.txt decides.
  const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(
    term,
  )}&sort=new&limit=25&t=month&raw_json=1`;
  return httpClient.getJson<RedditListing>(url, { signal: context.signal });
}

/** Client-credentials token for Reddit's documented app-only API. */
async function getAppToken(context: CollectorContext): Promise<string | null> {
  if (!config.redditClientId || !config.redditClientSecret) return null;
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.token;

  try {
    const basic = Buffer.from(`${config.redditClientId}:${config.redditClientSecret}`).toString(
      'base64',
    );
    const response = await rawFetch('https://www.reddit.com/api/v1/access_token', {
      method: 'POST',
      body: 'grant_type=client_credentials',
      signal: context.signal,
      accept: 'application/json',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    if (!response.ok) {
      logger.warn('reddit token request rejected', { status: response.status });
      return null;
    }

    const parsed = JSON.parse(response.body) as { access_token?: string; expires_in?: number };
    if (!parsed.access_token) return null;

    tokenCache = {
      token: parsed.access_token,
      expiresAt: Date.now() + (parsed.expires_in ?? 3600) * 1000,
    };
    return tokenCache.token;
  } catch (error) {
    logger.warn('reddit oauth failed', { reason: describeError(error) });
    return null;
  }
}
