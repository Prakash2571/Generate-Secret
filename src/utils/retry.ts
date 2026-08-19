import { describeError, logger } from './logger';
import { sleep } from './time';

export interface RetryOptions {
  retries: number;
  baseDelayMs?: number;
  factor?: number;
  maxDelayMs?: number;
  label: string;
  signal?: AbortSignal;
  /** Return false to fail immediately (e.g. HTTP 404). */
  isRetryable?: (error: unknown) => boolean;
}

export class AbortedError extends Error {
  constructor(label: string) {
    super(`${label} aborted (shutdown requested)`);
    this.name = 'AbortedError';
  }
}

/** Runs `fn` with exponential backoff and full jitter. */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const {
    retries,
    baseDelayMs = 500,
    factor = 2,
    maxDelayMs = 15_000,
    label,
    signal,
    isRetryable = () => true,
  } = options;

  let attempt = 0;
  for (;;) {
    if (signal?.aborted) throw new AbortedError(label);
    try {
      return await fn();
    } catch (error) {
      if (signal?.aborted) throw new AbortedError(label);
      if (attempt >= retries || !isRetryable(error)) throw error;

      const exponential = Math.min(maxDelayMs, baseDelayMs * factor ** attempt);
      // Full jitter keeps retries from synchronising across collectors.
      const delay = Math.round(exponential / 2 + Math.random() * (exponential / 2));
      attempt += 1;
      logger.debug('retrying after failure', {
        label,
        attempt,
        of: retries,
        delayMs: delay,
        reason: describeError(error),
      });
      await sleep(delay, signal);
    }
  }
}
