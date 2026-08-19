import type { CouponCandidate, SourceType } from '../types';

export interface CollectorContext {
  /** Aborted when shutdown starts; collectors must stop issuing new requests. */
  signal: AbortSignal;
  now: Date;
  /** Hard cap on candidates this collector should return. */
  maxCandidates: number;
}

/**
 * A source of publicly published offers.
 *
 * Collectors are independent: one throwing or timing out must never stop the
 * others (the discovery service isolates every call).
 */
export interface Collector {
  name: string;
  sourceType: SourceType;
  /** Human-readable description shown in logs/README. */
  description: string;
  enabled: boolean;
  collect(context: CollectorContext): Promise<CouponCandidate[]>;
}
