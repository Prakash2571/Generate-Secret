import { logger } from './logger';
import { rawFetch } from './rawFetch';
import { safeDomain } from './concurrency';
import { DAY_MS } from './time';

interface RobotsRules {
  disallow: string[];
  allow: string[];
  fetchedAt: number;
  /** Crawl-delay in ms if the site asked for one. */
  crawlDelayMs?: number;
}

/**
 * Minimal, conservative robots.txt support.
 *
 * This is a politeness feature, not a security control: if robots.txt cannot be
 * fetched we proceed (that is standard crawler behaviour), but any explicit
 * Disallow rule matching our path is respected.
 */
export class RobotsCache {
  private readonly cache = new Map<string, RobotsRules>();
  private readonly inflight = new Map<string, Promise<RobotsRules>>();
  private readonly ttlMs = DAY_MS;

  async isAllowed(url: string, signal?: AbortSignal): Promise<boolean> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;

    const rules = await this.rulesFor(parsed, signal);
    const path = `${parsed.pathname}${parsed.search}`;

    const longestMatch = (patterns: string[]): number => {
      let best = -1;
      for (const pattern of patterns) {
        if (matchesRobotsPattern(path, pattern) && pattern.length > best) best = pattern.length;
      }
      return best;
    };

    const disallowed = longestMatch(rules.disallow);
    if (disallowed < 0) return true;
    // A more specific Allow rule wins, per the de-facto standard.
    return longestMatch(rules.allow) >= disallowed;
  }

  async crawlDelayMs(url: string, signal?: AbortSignal): Promise<number | undefined> {
    try {
      const rules = await this.rulesFor(new URL(url), signal);
      return rules.crawlDelayMs;
    } catch {
      return undefined;
    }
  }

  private async rulesFor(url: URL, signal?: AbortSignal): Promise<RobotsRules> {
    const domain = safeDomain(url.href);
    const cached = this.cache.get(domain);
    if (cached && Date.now() - cached.fetchedAt < this.ttlMs) return cached;

    const pending = this.inflight.get(domain);
    if (pending) return pending;

    const task = this.fetchRules(url, domain, signal)
      .then((rules) => {
        this.cache.set(domain, rules);
        return rules;
      })
      .finally(() => this.inflight.delete(domain));

    this.inflight.set(domain, task);
    return task;
  }

  private async fetchRules(url: URL, domain: string, signal?: AbortSignal): Promise<RobotsRules> {
    const robotsUrl = `${url.protocol}//${url.host}/robots.txt`;
    const empty: RobotsRules = { disallow: [], allow: [], fetchedAt: Date.now() };
    try {
      const response = await rawFetch(robotsUrl, {
        signal,
        timeoutMs: 10_000,
        accept: 'text/plain,*/*;q=0.8',
        maxBytes: 500_000,
      });
      if (response.status === 404 || !response.ok) return empty;
      const parsed = parseRobots(response.body);
      logger.debug('robots.txt loaded', {
        domain,
        disallowRules: parsed.disallow.length,
        crawlDelayMs: parsed.crawlDelayMs,
      });
      return parsed;
    } catch (error) {
      logger.debug('robots.txt unavailable, proceeding politely', { domain });
      return empty;
    }
  }
}

/** Parses robots.txt, honouring both our UA token and the `*` group. */
export function parseRobots(text: string): RobotsRules {
  const rules: RobotsRules = { disallow: [], allow: [], fetchedAt: Date.now() };
  const lines = text.split(/\r?\n/);

  let activeGroups: string[] = [];
  let previousWasUserAgent = false;

  for (const rawLine of lines) {
    const line = rawLine.split('#')[0]?.trim() ?? '';
    if (!line) continue;
    const separator = line.indexOf(':');
    if (separator < 0) continue;

    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === 'user-agent') {
      if (!previousWasUserAgent) activeGroups = [];
      activeGroups.push(value.toLowerCase());
      previousWasUserAgent = true;
      continue;
    }
    previousWasUserAgent = false;

    const applies = activeGroups.some(
      (group) => group === '*' || group.includes('sheincouponfinder'),
    );
    if (!applies) continue;

    if (field === 'disallow') {
      if (value) rules.disallow.push(value);
    } else if (field === 'allow') {
      if (value) rules.allow.push(value);
    } else if (field === 'crawl-delay') {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds > 0) {
        rules.crawlDelayMs = Math.min(30_000, seconds * 1000);
      }
    }
  }

  return rules;
}

/** Supports the `*` wildcard and `$` end-anchor used by robots.txt. */
export function matchesRobotsPattern(path: string, pattern: string): boolean {
  if (pattern === '') return false;
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const escaped = body.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  const regex = new RegExp(`^${escaped}${anchored ? '$' : ''}`);
  return regex.test(path);
}

export const robotsCache = new RobotsCache();
