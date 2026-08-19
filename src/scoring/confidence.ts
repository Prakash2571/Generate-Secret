import type { CouponSourceEntry, ICoupon } from '../db/models/Coupon';
import { daysSince, hoursSince } from '../utils/time';

export interface ConfidenceFactor {
  label: string;
  points: number;
}

export interface ConfidenceResult {
  score: number;
  factors: ConfidenceFactor[];
}

/** Fields the scorer needs; accepts full documents or lean objects. */
export type ConfidenceInput = Pick<
  ICoupon,
  | 'sources'
  | 'lastSeenAt'
  | 'expiryDate'
  | 'conflictingSources'
  | 'cartAcceptedAt'
  | 'officialConfirmedAt'
>;

/** Cart acceptance older than this is no longer treated as current evidence. */
const CART_EVIDENCE_VALID_HOURS = 48;
/** Official confirmation older than this stops counting as "current". */
const OFFICIAL_EVIDENCE_VALID_DAYS = 7;
/** Third-party sources older than this are not counted as recent corroboration. */
const THIRD_PARTY_RECENT_DAYS = 30;

/** Registrable-ish domain, so www/m/amp subdomains are not counted twice. */
export function normaliseDomain(input: string | undefined): string {
  if (!input) return '';
  let host = input.toLowerCase().trim();
  try {
    if (host.includes('://')) host = new URL(host).hostname.toLowerCase();
  } catch {
    /* fall through to raw string handling */
  }
  host = host.replace(/^(www|m|amp|mobile)\./, '');
  return host;
}

/** Counts distinct non-official domains that published the offer recently. */
export function countIndependentSources(
  sources: readonly CouponSourceEntry[],
  now: Date = new Date(),
): number {
  const domains = new Set<string>();
  for (const source of sources) {
    if (source.type === 'official') continue;
    if (daysSince(source.lastSeenAt, now) > THIRD_PARTY_RECENT_DAYS) continue;
    const domain = normaliseDomain(source.domain ?? source.url);
    if (domain) domains.add(domain);
  }
  return domains.size;
}

/**
 * 0-100 confidence in the *claim*, which is not the same thing as validation
 * state: a coupon can legitimately be confidence 80 / status unverified.
 *
 * Point rules follow the specification; third-party corroboration is capped so
 * that ten affiliate sites copying one another can never look like proof.
 */
export function scoreConfidence(coupon: ConfidenceInput, now: Date = new Date()): ConfidenceResult {
  const factors: ConfidenceFactor[] = [];
  const add = (label: string, points: number): void => {
    if (points !== 0) factors.push({ label, points });
  };

  // --- Strongest evidence: a real coupon field accepted the code ------------
  if (coupon.cartAcceptedAt && hoursSince(coupon.cartAcceptedAt, now) <= CART_EVIDENCE_VALID_HOURS) {
    add('accepted by legitimate cart validation', 50);
  }

  // --- Official customer-facing publication --------------------------------
  const officialSources = coupon.sources.filter((source) => source.type === 'official');
  const freshOfficial = officialSources.some(
    (source) => daysSince(source.lastSeenAt, now) <= OFFICIAL_EVIDENCE_VALID_DAYS,
  );
  if (
    freshOfficial ||
    (coupon.officialConfirmedAt &&
      daysSince(coupon.officialConfirmedAt, now) <= OFFICIAL_EVIDENCE_VALID_DAYS)
  ) {
    add('current official SHEIN source', 35);
  }

  // --- Independent third-party corroboration (capped at +15) ---------------
  const independent = countIndependentSources(coupon.sources, now);
  if (independent >= 2) add('second independent recent source', 10);
  if (independent >= 3) add('third independent recent source', 5);

  // --- Freshness -----------------------------------------------------------
  const seenHoursAgo = hoursSince(coupon.lastSeenAt, now);
  if (seenHoursAgo <= 24) {
    add('seen within 24 hours', 10);
  } else if (seenHoursAgo <= 24 * 7) {
    add('seen within 7 days', 5);
  }
  if (daysSince(coupon.lastSeenAt, now) > 30) {
    add('not seen for over 30 days', -20);
  }

  // --- Penalties -----------------------------------------------------------
  if (coupon.conflictingSources) {
    add('sources disagree on the offer terms', -20);
  }
  const reportedExpired = coupon.sources.some((source) => source.reportedExpired === true);
  const pastExpiry = coupon.expiryDate !== undefined && coupon.expiryDate.getTime() < now.getTime();
  if (reportedExpired || pastExpiry) {
    add(reportedExpired ? 'reported expired by a source' : 'past its published expiry date', -50);
  }

  const raw = factors.reduce((total, factor) => total + factor.points, 0);
  const score = Math.max(0, Math.min(100, Math.round(raw)));

  return { score, factors };
}
