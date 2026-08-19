export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/** Formats a date as "YYYY-MM-DD HH:mm IST" (the report timezone). */
export function formatIST(date: Date | undefined | null): string {
  if (!date) return 'never';
  const time = date.getTime();
  if (!Number.isFinite(time)) return 'unknown';
  // IST is a fixed UTC+05:30 offset, so this needs no tz database.
  const shifted = new Date(time + 5.5 * HOUR_MS);
  const iso = shifted.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} IST`;
}

export function hoursSince(date: Date | undefined | null, now: Date = new Date()): number {
  if (!date) return Number.POSITIVE_INFINITY;
  return (now.getTime() - date.getTime()) / HOUR_MS;
}

export function daysSince(date: Date | undefined | null, now: Date = new Date()): number {
  if (!date) return Number.POSITIVE_INFINITY;
  return (now.getTime() - date.getTime()) / DAY_MS;
}

export function humanDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m${seconds.toString().padStart(2, '0')}s`;
}

/** Sleep that resolves early (without throwing) when the signal aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Rejects if `promise` does not settle within `ms`. */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
