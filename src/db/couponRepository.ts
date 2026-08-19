import crypto from 'node:crypto';
import { analyzeCoupon } from '../calculations/discount';
import { config } from '../config';
import { scoreConfidence } from '../scoring/confidence';
import type { CouponCandidate, CouponStatus, ValidationOutcome } from '../types';
import { describeError, logger } from '../utils/logger';
import { hoursSince } from '../utils/time';
import { CouponModel, type CouponDocument, type CouponSourceEntry, type ICoupon } from './models/Coupon';
import { CouponObservationModel, type ObservationEvent } from './models/CouponObservation';

/** Coupon codes are compared case-insensitively after trimming. */
export function normaliseCode(code: string | undefined): string | undefined {
  if (!code) return undefined;
  const normalised = code.trim().toUpperCase().replace(/\s+/g, '');
  return normalised.length > 0 ? normalised : undefined;
}

/**
 * Stable identity for an offer.
 *
 * Coded offers are keyed by the code alone, so five sites publishing SHEIN800
 * converge on one document with five sources. Code-less promotions fall back to
 * a fingerprint of their normalised terms.
 */
export function buildDedupeKey(candidate: CouponCandidate): string {
  const code = normaliseCode(candidate.code);
  if (code) return `CODE:${code}`;

  const canonical = [
    candidate.discountType,
    candidate.discountValue ?? '',
    candidate.minimumOrder ?? '',
    candidate.maximumDiscount ?? '',
    candidate.isUpTo ? 'upto' : 'exact',
    (candidate.title ?? candidate.rawText).toLowerCase().replace(/[^a-z0-9%₹ ]/gi, '').replace(/\s+/g, ' ').trim().slice(0, 90),
  ].join('|');

  return `OFFER:${crypto.createHash('sha1').update(canonical).digest('hex').slice(0, 20)}`;
}

export interface UpsertResult {
  coupon: CouponDocument;
  isNew: boolean;
  changes: string[];
}

/**
 * Inserts or updates one candidate.
 * Rediscovery never creates a duplicate: it refreshes terms, adds/updates the
 * source entry and appends an observation.
 */
export async function upsertCandidate(
  candidate: CouponCandidate,
  now: Date = new Date(),
): Promise<UpsertResult> {
  const dedupeKey = buildDedupeKey(candidate);
  const code = normaliseCode(candidate.code);

  let existing = await CouponModel.findOne({ dedupeKey }).exec();

  if (!existing) {
    const created = await createCoupon(candidate, dedupeKey, code, now);
    return created;
  }

  const before = snapshot(existing);
  mergeSource(existing, candidate, now);
  mergeTerms(existing, candidate);
  existing.lastSeenAt = maxDate(existing.lastSeenAt, candidate.source.lastSeenAt ?? now);
  applyExpiryState(existing, now);
  refreshDerived(existing, now);

  const changes = diffSnapshots(before, snapshot(existing));
  const statusChanged = before.status !== existing.status;

  await existing.save();

  const event: ObservationEvent =
    changes.length > 0 ? (statusChanged ? 'status_changed' : 'terms_changed') : 'rediscovered';

  await recordObservation(existing, {
    event,
    source: candidate.source,
    changes,
    previousStatus: statusChanged ? before.status : undefined,
    observedAt: now,
  });

  return { coupon: existing, isNew: false, changes };
}

async function createCoupon(
  candidate: CouponCandidate,
  dedupeKey: string,
  code: string | undefined,
  now: Date,
): Promise<UpsertResult> {
  const discoveredAt = candidate.source.discoveredAt ?? now;

  const doc = new CouponModel({
    code,
    title: candidate.title,
    discountType: candidate.discountType,
    discountValue: candidate.discountValue,
    minimumOrder: candidate.minimumOrder,
    maximumDiscount: candidate.maximumDiscount,
    currency: 'INR',
    country: 'India',
    isUpTo: candidate.isUpTo,
    minimumOrderKnown: candidate.minimumOrderKnown,
    newUsersOnly: candidate.newUsersOnly,
    existingUsersAllowed: candidate.existingUsersAllowed,
    appOnly: candidate.appOnly,
    selectedUsersOnly: candidate.selectedUsersOnly,
    selectedProductsOnly: candidate.selectedProductsOnly,
    firstOrderOnly: candidate.firstOrderOnly,
    expiryDate: candidate.expiryDate,
    // Discovery alone never means valid.
    status: 'unverified' as CouponStatus,
    confidence: 0,
    sources: [toSourceEntry(candidate, now)],
    sourceCount: 1,
    dedupeKey,
    conflictingSources: false,
    hasOfficialSource: candidate.source.type === 'official',
    officialConfirmedAt: candidate.source.type === 'official' ? now : undefined,
    targetMatch: false,
    firstSeenAt: discoveredAt,
    lastSeenAt: candidate.source.lastSeenAt ?? now,
    validationAttempts: 0,
  });

  applyExpiryState(doc, now);
  refreshDerived(doc, now);

  try {
    await doc.save();
  } catch (error) {
    // Another concurrent write won the race - merge into the winner instead.
    if (isDuplicateKeyError(error)) {
      logger.debug('duplicate dedupeKey on insert, merging instead', { dedupeKey });
      const winner = await CouponModel.findOne({ dedupeKey }).exec();
      if (winner) {
        mergeSource(winner, candidate, now);
        mergeTerms(winner, candidate);
        applyExpiryState(winner, now);
        refreshDerived(winner, now);
        await winner.save();
        return { coupon: winner, isNew: false, changes: [] };
      }
    }
    throw error;
  }

  await recordObservation(doc, {
    event: 'discovered',
    source: candidate.source,
    observedAt: now,
  });

  return { coupon: doc, isNew: true, changes: [] };
}

function toSourceEntry(candidate: CouponCandidate, now: Date): CouponSourceEntry {
  return {
    name: candidate.source.name,
    url: candidate.source.url,
    type: candidate.source.type,
    domain: candidate.source.domain,
    discoveredAt: candidate.source.discoveredAt ?? now,
    lastSeenAt: candidate.source.lastSeenAt ?? now,
    snippet: candidate.source.snippet?.slice(0, 400),
    claim: {
      discountType: candidate.discountType,
      discountValue: candidate.discountValue,
      minimumOrder: candidate.minimumOrder,
      maximumDiscount: candidate.maximumDiscount,
    },
    reportedExpired: candidate.reportedExpired,
  };
}

/** Adds a new source or refreshes the existing entry for that URL. */
function mergeSource(doc: CouponDocument, candidate: CouponCandidate, now: Date): void {
  const entry = toSourceEntry(candidate, now);
  const index = doc.sources.findIndex(
    (source) => source.url === entry.url && source.name === entry.name,
  );

  if (index >= 0) {
    const current = doc.sources[index] as CouponSourceEntry;
    current.lastSeenAt = maxDate(current.lastSeenAt, entry.lastSeenAt);
    current.claim = entry.claim;
    current.snippet = entry.snippet ?? current.snippet;
    current.reportedExpired = entry.reportedExpired;
    doc.markModified('sources');
  } else {
    doc.sources.push(entry);
  }

  doc.sourceCount = doc.sources.length;
  doc.hasOfficialSource = doc.sources.some((source) => source.type === 'official');
  if (entry.type === 'official') {
    doc.officialConfirmedAt = maxDate(doc.officialConfirmedAt, entry.lastSeenAt);
  }
  doc.conflictingSources = computeConflicts(doc.sources);
}

/**
 * Reconciles claims from different publishers.
 *
 * Rules: official sources win; otherwise unknown values are filled in and
 * genuine disagreements resolve to the *conservative* value (higher minimum
 * order, lower cap) and raise the conflict flag.
 */
function mergeTerms(doc: CouponDocument, candidate: CouponCandidate): void {
  const official = candidate.source.type === 'official';

  if (doc.discountType === 'unknown' && candidate.discountType !== 'unknown') {
    doc.discountType = candidate.discountType;
    doc.discountValue = candidate.discountValue;
  } else if (official && candidate.discountType !== 'unknown') {
    doc.discountType = candidate.discountType;
    if (candidate.discountValue !== undefined) doc.discountValue = candidate.discountValue;
  } else if (doc.discountValue === undefined && candidate.discountValue !== undefined) {
    doc.discountValue = candidate.discountValue;
  }

  // Minimum order: knowing it matters more than any single claimed number.
  if (candidate.minimumOrderKnown && candidate.minimumOrder !== undefined) {
    if (!doc.minimumOrderKnown || doc.minimumOrder === undefined) {
      doc.minimumOrder = candidate.minimumOrder;
      doc.minimumOrderKnown = true;
    } else if (official) {
      doc.minimumOrder = candidate.minimumOrder;
    } else if (candidate.minimumOrder > doc.minimumOrder) {
      doc.minimumOrder = candidate.minimumOrder;
    }
  }

  if (candidate.maximumDiscount !== undefined) {
    if (doc.maximumDiscount === undefined || official) {
      doc.maximumDiscount = candidate.maximumDiscount;
    } else {
      doc.maximumDiscount = Math.min(doc.maximumDiscount, candidate.maximumDiscount);
    }
  }

  // "up to" wording from any publisher keeps the offer hedged unless an
  // official page states an exact value.
  doc.isUpTo = official ? candidate.isUpTo : doc.isUpTo || candidate.isUpTo;

  // Restrictions are unioned: they must always be surfaced to the user.
  doc.newUsersOnly = orFlag(doc.newUsersOnly, candidate.newUsersOnly);
  doc.appOnly = orFlag(doc.appOnly, candidate.appOnly);
  doc.selectedUsersOnly = orFlag(doc.selectedUsersOnly, candidate.selectedUsersOnly);
  doc.selectedProductsOnly = orFlag(doc.selectedProductsOnly, candidate.selectedProductsOnly);
  doc.firstOrderOnly = orFlag(doc.firstOrderOnly, candidate.firstOrderOnly);
  if (candidate.existingUsersAllowed !== undefined) {
    doc.existingUsersAllowed = official
      ? candidate.existingUsersAllowed
      : (doc.existingUsersAllowed ?? candidate.existingUsersAllowed);
  }

  if (candidate.expiryDate) {
    if (!doc.expiryDate || official) {
      doc.expiryDate = candidate.expiryDate;
    } else if (candidate.expiryDate.getTime() < doc.expiryDate.getTime()) {
      // Earliest credible expiry is the safe assumption.
      doc.expiryDate = candidate.expiryDate;
    }
  }

  if (!doc.title && candidate.title) doc.title = candidate.title;
  if (!doc.code) doc.code = normaliseCode(candidate.code);
}

function orFlag(current: boolean | undefined, incoming: boolean | undefined): boolean | undefined {
  if (incoming === true) return true;
  return current;
}

/** True when publishers make materially different concrete claims. */
export function computeConflicts(sources: readonly CouponSourceEntry[]): boolean {
  const claims = sources
    .map((source) => source.claim)
    .filter((claim): claim is NonNullable<CouponSourceEntry['claim']> => Boolean(claim));

  const concrete = claims.filter(
    (claim) => claim.discountValue !== undefined && claim.discountType !== undefined,
  );
  if (concrete.length < 2) return false;

  for (let i = 0; i < concrete.length; i += 1) {
    for (let j = i + 1; j < concrete.length; j += 1) {
      const a = concrete[i] as NonNullable<CouponSourceEntry['claim']>;
      const b = concrete[j] as NonNullable<CouponSourceEntry['claim']>;
      if (a.discountType !== b.discountType) return true;
      if (a.discountValue !== b.discountValue) return true;
      if (
        a.minimumOrder !== undefined &&
        b.minimumOrder !== undefined &&
        a.minimumOrder !== b.minimumOrder
      ) {
        return true;
      }
    }
  }
  return false;
}

/** Moves a coupon to `expired` once its published expiry date has passed. */
export function applyExpiryState(doc: CouponDocument, now: Date): void {
  if (doc.expiryDate && doc.expiryDate.getTime() < now.getTime() && doc.status !== 'expired') {
    doc.status = 'expired';
    doc.validationNotes = `published expiry ${doc.expiryDate.toISOString()} has passed`;
    doc.validationMethod = 'expiry-date';
  }
}

/** Recomputes confidence and the cached target analysis. */
export function refreshDerived(doc: CouponDocument, now: Date = new Date()): void {
  const { score } = scoreConfidence(doc, now);
  doc.confidence = score;

  const analysis = analyzeCoupon(doc);
  doc.targetMatch = analysis.targetMatch;
  doc.discountAtTarget = analysis.discountAtTarget;
  doc.finalPriceAtTarget = analysis.breakdowns.find(
    (entry) => entry.cartValue === analysis.targetCartValue,
  )?.applicable
    ? analysis.finalPriceAtTarget
    : undefined;
  doc.effectiveDiscountAtTarget = analysis.effectiveDiscountAtTarget;
}

/** Applies a validation result, never inventing a `valid` state. */
export async function applyValidationOutcome(
  doc: CouponDocument,
  outcome: ValidationOutcome,
  now: Date = new Date(),
): Promise<void> {
  const previousStatus = doc.status;

  doc.status = outcome.status;
  doc.lastValidatedAt = now;
  doc.validationMethod = outcome.method;
  doc.validationNotes = outcome.notes.slice(0, 1000);
  doc.validationAttempts += 1;

  if (outcome.acceptedByCart) doc.cartAcceptedAt = now;

  if (outcome.observedTerms) {
    const terms = outcome.observedTerms;
    if (terms.minimumOrder !== undefined) {
      doc.minimumOrder = terms.minimumOrder;
      doc.minimumOrderKnown = true;
    }
    if (terms.discountValue !== undefined) doc.discountValue = terms.discountValue;
    if (terms.discountType !== undefined) doc.discountType = terms.discountType;
    if (terms.maximumDiscount !== undefined) doc.maximumDiscount = terms.maximumDiscount;
    if (terms.expiryDate !== undefined) doc.expiryDate = terms.expiryDate;
  }

  applyExpiryState(doc, now);
  refreshDerived(doc, now);
  await doc.save();

  await recordObservation(doc, {
    event: previousStatus === doc.status ? 'validated' : 'status_changed',
    previousStatus: previousStatus === doc.status ? undefined : previousStatus,
    validationResult: `${outcome.status}: ${outcome.notes}`.slice(0, 500),
    validationMethod: outcome.method,
    observedAt: now,
  });
}

export interface ObservationInput {
  event: ObservationEvent;
  source?: CouponCandidate['source'];
  changes?: string[];
  previousStatus?: CouponStatus;
  validationResult?: string;
  validationMethod?: string;
  observedAt: Date;
}

/** Appends an immutable history entry. Failures here never break a scan. */
export async function recordObservation(
  doc: CouponDocument,
  input: ObservationInput,
): Promise<void> {
  try {
    await CouponObservationModel.create({
      couponId: doc._id,
      code: doc.code,
      event: input.event,
      status: doc.status,
      previousStatus: input.previousStatus,
      source: input.source
        ? { name: input.source.name, url: input.source.url, type: input.source.type }
        : undefined,
      discountType: doc.discountType,
      discountValue: doc.discountValue,
      minimumOrder: doc.minimumOrder,
      maximumDiscount: doc.maximumDiscount,
      confidence: doc.confidence,
      validationResult: input.validationResult,
      validationMethod: input.validationMethod,
      changes: input.changes && input.changes.length > 0 ? input.changes : undefined,
      observedAt: input.observedAt,
    });
  } catch (error) {
    logger.warn('failed to write coupon observation', {
      code: doc.code,
      reason: describeError(error),
    });
  }
}

interface Snapshot {
  status: CouponStatus;
  discountType: string;
  discountValue?: number;
  minimumOrder?: number;
  maximumDiscount?: number;
  isUpTo: boolean;
  expiryDate?: number;
  sourceCount: number;
  newUsersOnly?: boolean;
  appOnly?: boolean;
  selectedUsersOnly?: boolean;
  selectedProductsOnly?: boolean;
}

function snapshot(doc: CouponDocument): Snapshot {
  return {
    status: doc.status,
    discountType: doc.discountType,
    discountValue: doc.discountValue,
    minimumOrder: doc.minimumOrder,
    maximumDiscount: doc.maximumDiscount,
    isUpTo: doc.isUpTo,
    expiryDate: doc.expiryDate?.getTime(),
    sourceCount: doc.sourceCount,
    newUsersOnly: doc.newUsersOnly,
    appOnly: doc.appOnly,
    selectedUsersOnly: doc.selectedUsersOnly,
    selectedProductsOnly: doc.selectedProductsOnly,
  };
}

function diffSnapshots(before: Snapshot, after: Snapshot): string[] {
  const changes: string[] = [];
  for (const key of Object.keys(before) as Array<keyof Snapshot>) {
    if (before[key] !== after[key]) {
      changes.push(`${key}: ${format(before[key])} -> ${format(after[key])}`);
    }
  }
  return changes;
}

function format(value: unknown): string {
  if (value === undefined) return 'unknown';
  if (typeof value === 'number' && value > 1e12) return new Date(value).toISOString();
  return String(value);
}

function maxDate(a: Date | undefined, b: Date | undefined): Date {
  const timeA = a?.getTime() ?? 0;
  const timeB = b?.getTime() ?? 0;
  return new Date(Math.max(timeA, timeB));
}

function isDuplicateKeyError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: number }).code === 11000,
  );
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Coupons whose validity information is stale, most promising first.
 *
 * Freshness thresholds are configurable: valid coupons are rechecked after
 * REVALIDATE_VALID_AFTER_HOURS, unverified ones much sooner, and invalid ones
 * only occasionally (offers do come back).
 */
export async function findCouponsNeedingValidation(
  limit: number,
  now: Date = new Date(),
): Promise<CouponDocument[]> {
  const candidates = await CouponModel.find({ status: { $ne: 'expired' } })
    .sort({ targetMatch: -1, finalPriceAtTarget: 1, confidence: -1, lastSeenAt: -1 })
    .limit(Math.max(limit * 5, limit))
    .exec();

  const due = candidates.filter((doc) => isValidationDue(doc, now));
  return due.slice(0, limit);
}

export function isValidationDue(doc: CouponDocument | ICoupon, now: Date = new Date()): boolean {
  if (doc.status === 'expired') return false;
  if (doc.expiryDate && doc.expiryDate.getTime() < now.getTime()) return true;

  const age = hoursSince(doc.lastValidatedAt, now);
  switch (doc.status) {
    case 'valid':
      return age >= config.revalidateValidAfterHours;
    case 'invalid':
      return age >= config.revalidateInvalidAfterHours;
    case 'manual_validation_required':
      // Re-check on the unverified cadence: the blocker may have gone away.
      return age >= config.revalidateUnverifiedAfterHours;
    case 'unverified':
    default:
      return age >= config.revalidateUnverifiedAfterHours;
  }
}

/** Sweeps coupons whose published expiry has passed. */
export async function expirePastDueCoupons(now: Date = new Date()): Promise<number> {
  const stale = await CouponModel.find({
    expiryDate: { $lt: now },
    status: { $ne: 'expired' },
  }).exec();

  for (const doc of stale) {
    const previousStatus = doc.status;
    applyExpiryState(doc, now);
    refreshDerived(doc, now);
    await doc.save();
    await recordObservation(doc, {
      event: 'expired',
      previousStatus,
      validationResult: 'published expiry date passed',
      validationMethod: 'expiry-date',
      observedAt: now,
    });
  }

  return stale.length;
}

/** Recomputes confidence for every coupon (freshness decays over time). */
export async function refreshAllConfidence(now: Date = new Date()): Promise<number> {
  const all = await CouponModel.find({}).exec();
  let updated = 0;
  for (const doc of all) {
    const before = doc.confidence;
    refreshDerived(doc, now);
    if (doc.confidence !== before || doc.isModified()) {
      await doc.save();
      updated += 1;
      if (Math.abs(doc.confidence - before) >= 5) {
        await recordObservation(doc, {
          event: 'confidence_changed',
          changes: [`confidence: ${before} -> ${doc.confidence}`],
          observedAt: now,
        });
      }
    }
  }
  return updated;
}

export async function getCouponsByStatus(status: CouponStatus): Promise<ICoupon[]> {
  return CouponModel.find({ status }).lean<ICoupon[]>().exec();
}

export async function getAllCoupons(): Promise<ICoupon[]> {
  return CouponModel.find({}).lean<ICoupon[]>().exec();
}

export async function countByStatus(): Promise<Record<string, number>> {
  const rows = await CouponModel.aggregate<{ _id: CouponStatus; count: number }>([
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]).exec();

  const counts: Record<string, number> = {};
  for (const row of rows) counts[row._id] = row.count;
  return counts;
}

export async function countCoupons(): Promise<number> {
  return CouponModel.countDocuments({}).exec();
}

export async function countObservations(): Promise<number> {
  return CouponObservationModel.countDocuments({}).exec();
}
