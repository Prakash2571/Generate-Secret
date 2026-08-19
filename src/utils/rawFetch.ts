import { config } from '../config';

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/**
 * Raised when a site presents a CAPTCHA / bot challenge.
 *
 * We deliberately never attempt to solve or bypass it - the caller logs the
 * situation and moves on.
 */
export class ChallengeError extends Error {
  constructor(
    readonly url: string,
    readonly detail: string,
  ) {
    super(`anti-bot challenge detected at ${url} (${detail}) - skipping, not bypassing`);
    this.name = 'ChallengeError';
  }
}

export interface RawResponse {
  status: number;
  ok: boolean;
  body: string;
  finalUrl: string;
  contentType: string;
}

const CHALLENGE_MARKERS: Array<{ pattern: RegExp; detail: string }> = [
  { pattern: /just a moment\.\.\./i, detail: 'cloudflare interstitial' },
  { pattern: /cf-browser-verification|cf_chl_opt|cf-challenge/i, detail: 'cloudflare challenge' },
  { pattern: /<title>[^<]*attention required[^<]*<\/title>/i, detail: 'cloudflare block page' },
  { pattern: /g-recaptcha|recaptcha\/api\.js|hcaptcha\.com\/1\/api\.js/i, detail: 'captcha widget' },
  { pattern: /px-captcha|perimeterx/i, detail: 'perimeterx challenge' },
  { pattern: /are you a human|verify you are human|unusual traffic from your/i, detail: 'human verification' },
  { pattern: /akamai reference number|access denied.*akamai/i, detail: 'akamai block page' },
];

/** Detects challenge pages so callers can bail out politely. */
export function detectChallenge(body: string, status: number): string | null {
  const head = body.slice(0, 20_000);
  for (const marker of CHALLENGE_MARKERS) {
    if (marker.pattern.test(head)) return marker.detail;
  }
  if ((status === 403 || status === 429 || status === 503) && /captcha|blocked|challenge/i.test(head)) {
    return `http ${status} with block markers`;
  }
  return null;
}

/** Single fetch attempt: timeout, descriptive UA, no redirect trickery. */
export async function rawFetch(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    accept?: string;
    maxBytes?: number;
  } = {},
): Promise<RawResponse> {
  const timeoutMs = options.timeoutMs ?? config.requestTimeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('request timeout')), timeoutMs);

  const onOuterAbort = (): void => controller.abort(new Error('shutdown requested'));
  options.signal?.addEventListener('abort', onOuterAbort, { once: true });

  try {
    const response = await fetch(url, {
      method: options.method ?? 'GET',
      body: options.body,
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': config.userAgent,
        Accept: options.accept ?? 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-IN,en;q=0.9',
        'Cache-Control': 'no-cache',
        ...options.headers,
      },
    });

    const contentType = response.headers.get('content-type') ?? '';
    const body = await readBounded(response, options.maxBytes ?? 3_000_000);

    return {
      status: response.status,
      ok: response.ok,
      body,
      finalUrl: response.url || url,
      contentType,
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`request timeout or aborted after ${timeoutMs}ms: ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onOuterAbort);
  }
}

/** Reads a response body but refuses to buffer unbounded amounts of data. */
async function readBounded(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return await response.text();

  const decoder = new TextDecoder('utf-8');
  let received = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    text += decoder.decode(value, { stream: true });
    if (received >= maxBytes) {
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  text += decoder.decode();
  return text;
}
