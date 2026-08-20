import type { CouponSourceEntry, ICoupon } from '../../src/db/models/Coupon';
import './setup';

/** Fixed "now" so freshness-sensitive assertions are deterministic. */
export const NOW = new Date('2026-08-19T15:00:00Z');

export function hoursAgo(hours: number, from: Date = NOW): Date {
  return new Date(from.getTime() - hours * 3_600_000);
}

export function daysAgo(days: number, from: Date = NOW): Date {
  return new Date(from.getTime() - days * 86_400_000);
}

export function makeSource(overrides: Partial<CouponSourceEntry> = {}): CouponSourceEntry {
  return {
    name: 'grabon',
    url: 'https://www.grabon.in/shein-coupons/',
    type: 'coupon-site',
    domain: 'grabon.in',
    discoveredAt: NOW,
    lastSeenAt: NOW,
    ...overrides,
  };
}

/** An official, currently-published source (the strongest evidence we accept). */
export function makeOfficialSource(overrides: Partial<CouponSourceEntry> = {}): CouponSourceEntry {
  return makeSource({
    name: 'officialShein',
    url: 'https://www.shein.in/coupon-a-1035.html',
    type: 'official',
    domain: 'shein.in',
    ...overrides,
  });
}

export function makeCoupon(overrides: Partial<ICoupon> = {}): ICoupon {
  return {
    code: 'TESTCODE1',
    title: 'Test offer',
    discountType: 'flat',
    discountValue: 800,
    minimumOrder: 1000,
    maximumDiscount: undefined,
    currency: 'INR',
    country: 'India',
    isUpTo: false,
    minimumOrderKnown: true,
    status: 'unverified',
    confidence: 0,
    sourceCount: 1,
    sources: [makeSource()],
    dedupeKey: 'CODE:TESTCODE1',
    conflictingSources: false,
    hasOfficialSource: false,
    targetMatch: false,
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    validationAttempts: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as ICoupon;
}

/** Captures everything written to stdout while `fn` runs. */
export async function captureStdout(fn: () => void | Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only stdout capture
  (process.stdout as any).write = (chunk: unknown): boolean => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    await fn();
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- restore original
    (process.stdout as any).write = original;
  }
  return chunks.join('');
}
