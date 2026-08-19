import { config } from '../config';
import { createLimiter, DomainThrottle, safeDomain } from './concurrency';
import { describeError, logger } from './logger';
import { ChallengeError, detectChallenge, HttpError, rawFetch, type RawResponse } from './rawFetch';
import { robotsCache } from './robots';
import { withRetry } from './retry';
import { sleep } from './time';

export { ChallengeError, HttpError };

export interface GetOptions {
  signal?: AbortSignal;
  headers?: Record<string, string>;
  timeoutMs?: number;
  retries?: number;
  accept?: string;
  /** Skip the robots.txt check (only for robots.txt itself). */
  ignoreRobots?: boolean;
}

export class RobotsDisallowedError extends Error {
  constructor(readonly url: string) {
    super(`robots.txt disallows ${url} - skipping`);
    this.name = 'RobotsDisallowedError';
  }
}

/**
 * Polite HTTP client shared by every collector.
 *
 * Guarantees: global concurrency cap, per-domain delay, request timeout,
 * bounded exponential-backoff retries, robots.txt respect, descriptive UA, and
 * hard failure (never bypass) on anti-bot challenges.
 */
export class HttpClient {
  private readonly limit = createLimiter(config.maxConcurrentRequests);
  private readonly throttle = new DomainThrottle(config.requestDelayMs);

  async get(url: string, options: GetOptions = {}): Promise<RawResponse> {
    if (!options.ignoreRobots) {
      const allowed = await robotsCache.isAllowed(url, options.signal);
      if (!allowed) throw new RobotsDisallowedError(url);
    }

    const retries = options.retries ?? config.maxRetries;

    return withRetry(
      async () => {
        return this.limit(async () => {
          await this.throttle.wait(url, options.signal);

          // Honour Crawl-delay on top of our own configured delay.
          const crawlDelay = await robotsCache.crawlDelayMs(url, options.signal);
          if (crawlDelay && crawlDelay > config.requestDelayMs) {
            await sleep(crawlDelay - config.requestDelayMs, options.signal);
          }

          const started = Date.now();
          const response = await rawFetch(url, {
            headers: options.headers,
            timeoutMs: options.timeoutMs,
            signal: options.signal,
            accept: options.accept,
          });

          logger.trace('http response', {
            url,
            status: response.status,
            ms: Date.now() - started,
            bytes: response.body.length,
          });

          const challenge = detectChallenge(response.body, response.status);
          if (challenge) throw new ChallengeError(url, challenge);

          if (!response.ok) {
            throw new HttpError(`HTTP ${response.status} for ${url}`, response.status, url);
          }
          return response;
        });
      },
      {
        retries,
        label: `GET ${safeDomain(url)}`,
        signal: options.signal,
        baseDelayMs: 800,
        maxDelayMs: 12_000,
        isRetryable: (error) => isRetryableHttpFailure(error),
      },
    );
  }

  /** Returns the response body, or null when the source could not be read. */
  async getText(url: string, options: GetOptions = {}): Promise<string | null> {
    try {
      const response = await this.get(url, options);
      return response.body;
    } catch (error) {
      if (error instanceof ChallengeError) {
        logger.warn('skipping source due to anti-bot challenge (not bypassed)', {
          url,
          reason: error.detail,
        });
        return null;
      }
      if (error instanceof RobotsDisallowedError) {
        logger.info('skipping source disallowed by robots.txt', { url });
        return null;
      }
      logger.debug('http get failed', { url, reason: describeError(error) });
      return null;
    }
  }

  async getJson<T>(url: string, options: GetOptions = {}): Promise<T | null> {
    const body = await this.getText(url, {
      ...options,
      accept: options.accept ?? 'application/json,text/plain;q=0.9,*/*;q=0.8',
    });
    if (body === null) return null;
    try {
      return JSON.parse(body) as T;
    } catch {
      logger.debug('response was not valid JSON', { url });
      return null;
    }
  }
}

/** 429/5xx and transport errors are worth retrying; 4xx generally is not. */
export function isRetryableHttpFailure(error: unknown): boolean {
  if (error instanceof ChallengeError) return false;
  if (error instanceof RobotsDisallowedError) return false;
  if (error instanceof HttpError) {
    return error.status === 429 || error.status >= 500;
  }
  return true;
}

export const httpClient = new HttpClient();
