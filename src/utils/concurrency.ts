import { sleep } from './time';

/** Classic counting semaphore. */
export class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(permits: number) {
    this.available = Math.max(1, Math.floor(permits));
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
      return;
    }
    this.available += 1;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

/** Creates a `limit(fn)` helper that never runs more than `permits` tasks at once. */
export function createLimiter(permits: number): <T>(fn: () => Promise<T>) => Promise<T> {
  const semaphore = new Semaphore(permits);
  return <T>(fn: () => Promise<T>) => semaphore.run(fn);
}

/**
 * Enforces a minimum delay between consecutive requests to the same host.
 * Politeness is per-domain so unrelated sites are not slowed down.
 */
export class DomainThrottle {
  private readonly nextAllowedAt = new Map<string, number>();
  private readonly chains = new Map<string, Promise<void>>();

  constructor(private readonly minDelayMs: number) {}

  async wait(url: string, signal?: AbortSignal): Promise<void> {
    if (this.minDelayMs <= 0) return;
    const domain = safeDomain(url);

    // Serialise per domain so concurrent callers queue instead of racing.
    const previous = this.chains.get(domain) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.chains.set(
      domain,
      previous.then(() => current),
    );

    await previous;
    try {
      const now = Date.now();
      const allowedAt = this.nextAllowedAt.get(domain) ?? 0;
      if (allowedAt > now) {
        await sleep(allowedAt - now, signal);
      }
      this.nextAllowedAt.set(domain, Date.now() + this.minDelayMs);
    } finally {
      release();
    }
  }
}

export function safeDomain(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return 'unknown';
  }
}

/**
 * Maps over items with bounded concurrency. Rejections are captured per item so
 * one failure never aborts the batch.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<Array<{ ok: true; value: R } | { ok: false; error: unknown }>> {
  const results: Array<{ ok: true; value: R } | { ok: false; error: unknown }> = new Array(
    items.length,
  );
  let cursor = 0;
  const workers = Math.max(1, Math.min(Math.floor(concurrency), items.length || 1));

  async function runner(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        results[index] = { ok: true, value: await worker(items[index] as T, index) };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  }

  await Promise.all(Array.from({ length: workers }, () => runner()));
  return results;
}
