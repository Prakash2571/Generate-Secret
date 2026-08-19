/**
 * Shared domain types.
 *
 * The vocabulary here is intentionally strict: a "candidate" is something a
 * public page claimed, an "offer terms" object is what we could deterministically
 * parse from that claim, and a status is what we are willing to assert.
 */

export type DiscountType = 'flat' | 'percentage' | 'sale' | 'cashback' | 'unknown';

export type CouponStatus =
  | 'valid'
  | 'invalid'
  | 'expired'
  | 'unverified'
  | 'manual_validation_required';

export type SourceType = 'official' | 'coupon-site' | 'social' | 'community' | 'other';

/** A single publication of an offer by one page. */
export interface SourceRef {
  name: string;
  url: string;
  type: SourceType;
  discoveredAt: Date;
  lastSeenAt: Date;
  /** Domain the offer text was literally read from (used for lineage checks). */
  domain?: string;
  /** Verbatim snippet the parse came from - kept for auditability. */
  snippet?: string;
}

/**
 * Deterministically parsed offer conditions.
 *
 * `isUpTo` is the important one: "up to 80% off" must never be treated as a
 * guaranteed 80% coupon.
 */
export interface OfferTerms {
  discountType: DiscountType;
  discountValue?: number;
  minimumOrder?: number;
  maximumDiscount?: number;
  /** True when the advertised value is an upper bound ("up to 80% off"). */
  isUpTo: boolean;
  /** True when the minimum order was explicitly stated (not guessed). */
  minimumOrderKnown: boolean;
  newUsersOnly?: boolean;
  existingUsersAllowed?: boolean;
  appOnly?: boolean;
  selectedUsersOnly?: boolean;
  selectedProductsOnly?: boolean;
  firstOrderOnly?: boolean;
  expiryDate?: Date;
  /** The publishing page itself said this offer is expired/no longer working. */
  reportedExpired?: boolean;
}

/** One discovered offer, before deduplication/persistence. */
export interface CouponCandidate extends OfferTerms {
  /** Normalised (UPPERCASE, trimmed) coupon code, when the page published one. */
  code?: string;
  title?: string;
  /** Text the parser worked on. Trimmed to a sane length. */
  rawText: string;
  source: SourceRef;
}

/** Result of an attempted validation, produced by the validators. */
export interface ValidationOutcome {
  status: CouponStatus;
  method: string;
  notes: string;
  /** Only true when a customer-facing mechanism actually accepted the code. */
  acceptedByCart?: boolean;
  /** Terms the validation itself revealed (e.g. cart said "min spend 1299"). */
  observedTerms?: Partial<OfferTerms>;
}

/** Per-cart-value analysis used for ranking and reporting. */
export interface DiscountBreakdown {
  cartValue: number;
  discount: number;
  finalPrice: number;
  effectiveDiscount: number;
  applicable: boolean;
  reason?: string;
}

export interface TargetAnalysis {
  breakdowns: DiscountBreakdown[];
  targetCartValue: number;
  discountAtTarget: number;
  finalPriceAtTarget: number;
  effectiveDiscountAtTarget: number;
  /** Strict match: hits the target AND the terms are fully known. */
  targetMatch: boolean;
  /** Would hit the target, but only if unpublished conditions cooperate. */
  potentialTargetMatch: boolean;
  /** True when the numbers required an assumption (unknown minimum, "up to", ...). */
  uncertain: boolean;
  /** Why the figures are uncertain, if they are. */
  uncertaintyReason?: string;
}

export interface CollectorResult {
  collector: string;
  candidates: CouponCandidate[];
  errors: string[];
  durationMs: number;
}
