import fs from 'node:fs/promises';
import path from 'node:path';
import { formatOffer, formatRupees } from '../calculations/discount';
import { config } from '../config';
import { getAllCoupons } from '../db/couponRepository';
import type { ICoupon } from '../db/models/Coupon';
import { scoreConfidence } from '../scoring/confidence';
import { pickBest, rankCoupons, type RankedCoupon } from '../scoring/ranking';
import type { CouponStatus } from '../types';
import { describeError, logger } from '../utils/logger';
import { divider, renderTable } from '../utils/table';
import { formatIST } from '../utils/time';
import { runtimeState } from './state';

export interface ReportSnapshot {
  generatedAt: Date;
  ranked: RankedCoupon[];
  groups: Record<CouponStatus, RankedCoupon[]>;
  valid: RankedCoupon[];
  targetMatches: RankedCoupon[];
  potentialTargetMatches: RankedCoupon[];
  best?: RankedCoupon;
  counts: Record<string, number>;
}

const STATUS_ORDER: CouponStatus[] = [
  'valid',
  'manual_validation_required',
  'unverified',
  'invalid',
  'expired',
];

/** Reads current state from MongoDB and ranks it. Never mutates the database. */
export async function buildReport(now: Date = new Date()): Promise<ReportSnapshot> {
  const coupons = await getAllCoupons();
  const ranked = rankCoupons(coupons, now);

  const groups = STATUS_ORDER.reduce<Record<CouponStatus, RankedCoupon[]>>(
    (accumulator, status) => {
      accumulator[status] = ranked.filter((entry) => entry.coupon.status === status);
      return accumulator;
    },
    {} as Record<CouponStatus, RankedCoupon[]>,
  );

  const valid = groups.valid ?? [];
  const counts: Record<string, number> = { total: ranked.length };
  for (const status of STATUS_ORDER) counts[status] = groups[status]?.length ?? 0;

  return {
    generatedAt: now,
    ranked,
    groups,
    valid,
    // TARGET_MATCH is only awarded on verified-valid coupons with known terms.
    targetMatches: ranked.filter((entry) => entry.analysis.targetMatch),
    potentialTargetMatches: ranked.filter((entry) => entry.analysis.potentialTargetMatch),
    best: pickBest(valid),
    counts,
  };
}

// ---------------------------------------------------------------------------
// Console output
// ---------------------------------------------------------------------------

/** Per-scan table (specification section 23). */
export function printScanSummary(snapshot: ReportSnapshot): void {
  const rows = snapshot.ranked
    .filter((entry) => entry.coupon.status === 'valid' || entry.coupon.status === 'manual_validation_required')
    .slice(0, 25)
    .map((entry) => toTableRow(entry));

  // Fall back to the most promising unverified entries when nothing is proven.
  const displayRows =
    rows.length > 0
      ? rows
      : snapshot.ranked.slice(0, 15).map((entry) => toTableRow(entry));

  logger.raw('');
  logger.raw(
    renderTable({
      head: ['CODE', 'OFFER', 'MINIMUM', `\u20b9${config.targetCartValue} PAY`, 'STATUS', 'CONFIDENCE'],
      rows: displayRows,
      align: ['left', 'left', 'right', 'right', 'left', 'right'],
      maxWidths: [22, 26, 10, 12, 26, 10],
    }),
  );

  const summary = STATUS_ORDER.map((status) => `${status}=${snapshot.counts[status] ?? 0}`).join(' ');
  logger.raw(
    `Coupons: ${snapshot.counts.total ?? 0} (${summary}) | TARGET_MATCH: ${snapshot.targetMatches.length}` +
      ` | potential: ${snapshot.potentialTargetMatches.length}`,
  );
  logger.raw('');
}

function toTableRow(entry: RankedCoupon): string[] {
  const { coupon, analysis } = entry;
  const minimum =
    coupon.minimumOrderKnown && coupon.minimumOrder !== undefined
      ? formatRupees(coupon.minimumOrder)
      : '?';
  const payable = applicableAtTarget(entry)
    ? formatRupees(analysis.finalPriceAtTarget)
    : '-';

  return [
    coupon.code ?? '(no code)',
    formatOffer(coupon) + (analysis.targetMatch ? ' *TARGET*' : ''),
    minimum,
    payable,
    coupon.status.toUpperCase(),
    String(coupon.confidence),
  ];
}

/**
 * Final report printed on graceful shutdown (specification sections 5 and 24).
 *
 * Verified valid, manual-validation-required and unverified coupons are printed
 * in separate blocks and are never mixed.
 */
export function printFinalReport(snapshot: ReportSnapshot): void {
  const line = divider(52);

  logger.raw('');
  logger.raw(line);
  logger.raw('SHEIN INDIA COUPON FINDER \u2014 FINAL REPORT');
  logger.raw(line);
  logger.raw('');
  logger.raw(`Last scan: ${formatIST(runtimeState.lastScanCompletedAt ?? runtimeState.lastScanStartedAt)}`);
  logger.raw(`Report generated: ${formatIST(snapshot.generatedAt)}`);
  logger.raw(`Scans completed: ${runtimeState.scanCount}`);
  logger.raw('');

  if (snapshot.valid.length === 0) {
    logger.raw('No currently verified SHEIN India coupons were found.');
    logger.raw('');
  } else {
    logger.raw('VERIFIED VALID');
    logger.raw(`Valid coupons: ${snapshot.valid.length}`);
    logger.raw('');
    snapshot.valid.forEach((entry, index) => {
      for (const detail of describeEntry(entry, index + 1)) logger.raw(detail);
      logger.raw('');
    });
  }

  printGroup(
    'MANUAL VALIDATION REQUIRED',
    'These need something we will not do automatically (sign-in, OTP, CAPTCHA, a specific account or a qualifying cart).',
    snapshot.groups.manual_validation_required ?? [],
  );

  printGroup(
    'UNVERIFIED',
    'Published publicly, but current validity could not be established. Not the same as valid.',
    snapshot.groups.unverified ?? [],
  );

  const targets = snapshot.targetMatches;
  logger.raw(line);
  logger.raw(`TARGET \u2014 ~${formatRupees(config.targetDiscount)} OFF ${formatRupees(config.targetCartValue)}`);
  logger.raw(line);
  logger.raw('');
  if (targets.length === 0) {
    logger.raw(
      `No verified coupon currently delivers ${formatRupees(config.targetDiscount)} off ` +
        `${formatRupees(config.targetCartValue)} with published terms.`,
    );
    if (snapshot.potentialTargetMatches.length > 0) {
      logger.raw('');
      logger.raw(
        `${snapshot.potentialTargetMatches.length} offer(s) would reach the target if their ` +
          'unpublished conditions cooperate (listed as potential matches in the JSON report):',
      );
      for (const entry of snapshot.potentialTargetMatches.slice(0, 10)) {
        logger.raw(
          `  - ${entry.coupon.code ?? entry.coupon.title ?? 'offer'} (${formatOffer(entry.coupon)}, ` +
            `${entry.coupon.status.toUpperCase()}, ${entry.analysis.uncertaintyReason ?? 'assumptions required'})`,
        );
      }
    }
  } else {
    for (const [index, entry] of targets.entries()) {
      for (const detail of describeEntry(entry, index + 1)) logger.raw(detail);
      logger.raw('');
    }
  }
  logger.raw('');

  logger.raw(line);
  logger.raw('BEST COUPON');
  logger.raw(line);
  logger.raw('');
  if (!snapshot.best) {
    logger.raw('No verified valid coupon is available to recommend.');
  } else {
    for (const detail of describeBest(snapshot.best)) logger.raw(detail);
  }
  logger.raw('');
  logger.raw(line);
  logger.raw('');
}

function printGroup(title: string, subtitle: string, entries: readonly RankedCoupon[]): void {
  const line = divider(52);
  logger.raw(line);
  logger.raw(`${title} (${entries.length})`);
  logger.raw(line);
  logger.raw(subtitle);
  logger.raw('');
  if (entries.length === 0) {
    logger.raw('  (none)');
    logger.raw('');
    return;
  }
  entries.slice(0, 20).forEach((entry, index) => {
    const { coupon, analysis } = entry;
    logger.raw(`${index + 1}. ${coupon.code ?? coupon.title ?? 'offer'}`);
    logger.raw(`   Offer: ${formatOffer(coupon)}`);
    logger.raw(
      `   Minimum purchase: ${
        coupon.minimumOrderKnown && coupon.minimumOrder !== undefined
          ? formatRupees(coupon.minimumOrder)
          : 'not published'
      }`,
    );
    if (applicableAtTarget(entry)) {
      logger.raw(
        `   Expected payment on ${formatRupees(config.targetCartValue)}: ${formatRupees(
          analysis.finalPriceAtTarget,
        )}${analysis.uncertain ? ' (assumes unpublished conditions)' : ''}`,
      );
    }
    logger.raw(`   Status: ${coupon.status.toUpperCase()}`);
    logger.raw(`   Confidence: ${coupon.confidence}/100`);
    if (coupon.validationNotes) logger.raw(`   Why: ${coupon.validationNotes.slice(0, 200)}`);
    logger.raw('');
  });
  if (entries.length > 20) logger.raw(`   ... and ${entries.length - 20} more (see results/latest.json)`);
  logger.raw('');
}

function describeEntry(entry: RankedCoupon, position: number): string[] {
  const { coupon, analysis } = entry;
  const lines: string[] = [];

  lines.push(`${position}. ${coupon.code ?? coupon.title ?? 'offer without a code'}`);
  lines.push(`   Discount: ${describeDiscount(coupon)}`);
  if (coupon.maximumDiscount !== undefined) {
    lines.push(`   Maximum discount: ${formatRupees(coupon.maximumDiscount)}`);
  }
  lines.push(
    `   Minimum purchase: ${
      coupon.minimumOrderKnown && coupon.minimumOrder !== undefined
        ? formatRupees(coupon.minimumOrder)
        : 'not published'
    }`,
  );
  if (applicableAtTarget(entry)) {
    lines.push(
      `   Final amount on ${formatRupees(config.targetCartValue)}: ${formatRupees(analysis.finalPriceAtTarget)}`,
    );
    lines.push(`   Effective discount: ${(analysis.effectiveDiscountAtTarget * 100).toFixed(1)}%`);
  } else {
    lines.push(
      `   Final amount on ${formatRupees(config.targetCartValue)}: not applicable (${
        analysis.breakdowns.find((item) => item.cartValue === config.targetCartValue)?.reason ??
        'conditions unknown'
      })`,
    );
  }
  lines.push(`   New users: ${yesNo(coupon.newUsersOnly)}`);
  if (coupon.appOnly) lines.push('   App only: YES');
  if (coupon.selectedUsersOnly) lines.push('   Selected users only: YES');
  if (coupon.selectedProductsOnly) lines.push('   Selected products only: YES');
  if (coupon.firstOrderOnly) lines.push('   First order only: YES');
  lines.push('   India: YES');
  lines.push(`   Status: ${coupon.status.toUpperCase()}`);
  lines.push(`   Confidence: ${coupon.confidence}/100`);
  if (analysis.targetMatch) lines.push('   Tag: TARGET_MATCH');
  else if (analysis.potentialTargetMatch) lines.push('   Tag: POTENTIAL_TARGET_MATCH (assumptions required)');
  lines.push(`   Validated: ${formatIST(coupon.lastValidatedAt)} via ${coupon.validationMethod ?? 'n/a'}`);
  lines.push(`   Sources (${coupon.sourceCount}): ${sourceSummary(coupon)}`);

  return lines;
}

function describeBest(entry: RankedCoupon): string[] {
  const { coupon, analysis } = entry;
  return [
    `Code: ${coupon.code ?? '(no code - promotion applies automatically)'}`,
    `Discount: ${describeDiscount(coupon)}`,
    `Minimum purchase: ${
      coupon.minimumOrderKnown && coupon.minimumOrder !== undefined
        ? formatRupees(coupon.minimumOrder)
        : 'not published'
    }`,
    `Maximum discount: ${
      coupon.maximumDiscount !== undefined ? formatRupees(coupon.maximumDiscount) : 'not published'
    }`,
    `Expected payment on ${formatRupees(config.targetCartValue)}: ${
      applicableAtTarget(entry) ? formatRupees(analysis.finalPriceAtTarget) : 'not applicable'
    }`,
    `New user only: ${yesNo(coupon.newUsersOnly)}`,
    `App only: ${yesNo(coupon.appOnly)}`,
    `Selected users only: ${yesNo(coupon.selectedUsersOnly)}`,
    `Selected products: ${yesNo(coupon.selectedProductsOnly)}`,
    `Expiry: ${coupon.expiryDate ? formatIST(coupon.expiryDate) : 'not published'}`,
    `Last validated: ${formatIST(coupon.lastValidatedAt)}`,
    `Validation method: ${coupon.validationMethod ?? 'n/a'}`,
    `Confidence: ${coupon.confidence}/100`,
    `Sources: ${sourceSummary(coupon)}`,
  ];
}

function describeDiscount(coupon: ICoupon): string {
  if (coupon.discountValue === undefined) return formatOffer(coupon);
  const prefix = coupon.isUpTo ? 'up to ' : '';
  if (coupon.discountType === 'percentage' || coupon.discountType === 'sale') {
    return `${prefix}${coupon.discountValue}%`;
  }
  return `${prefix}${formatRupees(coupon.discountValue)}`;
}

function sourceSummary(coupon: ICoupon): string {
  const names = coupon.sources.map((source) => `${source.name}(${source.type})`);
  const unique = [...new Set(names)];
  return unique.length > 0 ? unique.slice(0, 6).join(', ') : 'none recorded';
}

function yesNo(value: boolean | undefined): string {
  if (value === true) return 'YES';
  if (value === false) return 'NO';
  return 'UNKNOWN';
}

function applicableAtTarget(entry: RankedCoupon): boolean {
  return (
    entry.analysis.breakdowns.find((item) => item.cartValue === entry.analysis.targetCartValue)
      ?.applicable ?? false
  );
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/**
 * Writes the four report files.
 * Failures are logged (with the likely fix) and never crash the scanner.
 */
export async function writeReports(snapshot: ReportSnapshot): Promise<void> {
  const directory = config.resultsDir;

  try {
    await fs.mkdir(directory, { recursive: true });
  } catch (error) {
    logger.warn('could not create results directory', {
      directory,
      reason: describeError(error),
    });
    return;
  }

  const full = serialiseReport(snapshot);
  const validOnly = {
    ...full,
    coupons: full.coupons.filter((entry) => entry.status === 'valid'),
    note:
      'Only coupons whose validity was established through official publication or an actual ' +
      'coupon-field acceptance appear here.',
  };

  await writeFile(path.join(directory, 'latest.json'), JSON.stringify(full, null, 2));
  await writeFile(path.join(directory, 'latest.csv'), toCsv(full.coupons));
  await writeFile(path.join(directory, 'valid-coupons.json'), JSON.stringify(validOnly, null, 2));
  await writeFile(path.join(directory, 'valid-coupons.csv'), toCsv(validOnly.coupons));

  logger.info('reports written', {
    directory,
    coupons: full.coupons.length,
    valid: validOnly.coupons.length,
  });
}

async function writeFile(filePath: string, contents: string): Promise<void> {
  try {
    await fs.writeFile(filePath, contents, 'utf8');
  } catch (error) {
    const reason = describeError(error);
    logger.warn('failed to write report file', { file: filePath, reason });
    if (/EACCES|EPERM/i.test(reason)) {
      logger.warn(
        'the mounted results directory is not writable by the container user; ' +
          'fix with: sudo chown -R 1000:1000 ./results',
      );
    }
  }
}

interface SerialisedCoupon {
  code: string | null;
  title: string | null;
  status: CouponStatus;
  confidence: number;
  confidenceFactors: Array<{ label: string; points: number }>;
  discountType: string;
  discountValue: number | null;
  minimumOrder: number | null;
  minimumOrderKnown: boolean;
  maximumDiscount: number | null;
  isUpTo: boolean;
  currency: string;
  country: string;
  newUsersOnly: boolean | null;
  existingUsersAllowed: boolean | null;
  appOnly: boolean | null;
  selectedUsersOnly: boolean | null;
  selectedProductsOnly: boolean | null;
  firstOrderOnly: boolean | null;
  expiryDate: string | null;
  targetMatch: boolean;
  potentialTargetMatch: boolean;
  uncertain: boolean;
  uncertaintyReason: string | null;
  discountAtTarget: number;
  finalPriceAtTarget: number | null;
  effectiveDiscountAtTarget: number;
  cartValueAnalysis: Array<{
    cartValue: number;
    discount: number;
    finalPrice: number;
    effectiveDiscount: number;
    applicable: boolean;
    reason: string | null;
  }>;
  independentSources: number;
  sourceCount: number;
  sources: Array<{
    name: string;
    url: string;
    type: string;
    discoveredAt: string;
    lastSeenAt: string;
    reportedExpired: boolean;
  }>;
  firstSeenAt: string;
  lastSeenAt: string;
  lastValidatedAt: string | null;
  validationMethod: string | null;
  validationNotes: string | null;
  cartAcceptedAt: string | null;
  officialConfirmedAt: string | null;
  conflictingSources: boolean;
}

export function serialiseReport(snapshot: ReportSnapshot): {
  generatedAt: string;
  generatedAtIST: string;
  lastScanCompletedAt: string | null;
  scansCompleted: number;
  target: { cartValue: number; discount: number; cartValueLadder: number[] };
  counts: Record<string, number>;
  best: SerialisedCoupon | null;
  targetMatches: SerialisedCoupon[];
  potentialTargetMatches: SerialisedCoupon[];
  coupons: SerialisedCoupon[];
} {
  return {
    generatedAt: snapshot.generatedAt.toISOString(),
    generatedAtIST: formatIST(snapshot.generatedAt),
    lastScanCompletedAt: runtimeState.lastScanCompletedAt?.toISOString() ?? null,
    scansCompleted: runtimeState.scanCount,
    target: {
      cartValue: config.targetCartValue,
      discount: config.targetDiscount,
      cartValueLadder: config.cartValueLadder,
    },
    counts: snapshot.counts,
    best: snapshot.best ? serialiseCoupon(snapshot.best) : null,
    targetMatches: snapshot.targetMatches.map(serialiseCoupon),
    potentialTargetMatches: snapshot.potentialTargetMatches.map(serialiseCoupon),
    coupons: snapshot.ranked.map(serialiseCoupon),
  };
}

function serialiseCoupon(entry: RankedCoupon): SerialisedCoupon {
  const { coupon, analysis } = entry;
  const atTarget = analysis.breakdowns.find((item) => item.cartValue === analysis.targetCartValue);

  return {
    code: coupon.code ?? null,
    title: coupon.title ?? null,
    status: coupon.status,
    confidence: coupon.confidence,
    confidenceFactors: scoreConfidence(coupon).factors,
    discountType: coupon.discountType,
    discountValue: coupon.discountValue ?? null,
    minimumOrder: coupon.minimumOrder ?? null,
    minimumOrderKnown: coupon.minimumOrderKnown,
    maximumDiscount: coupon.maximumDiscount ?? null,
    isUpTo: coupon.isUpTo,
    currency: coupon.currency,
    country: coupon.country,
    newUsersOnly: coupon.newUsersOnly ?? null,
    existingUsersAllowed: coupon.existingUsersAllowed ?? null,
    appOnly: coupon.appOnly ?? null,
    selectedUsersOnly: coupon.selectedUsersOnly ?? null,
    selectedProductsOnly: coupon.selectedProductsOnly ?? null,
    firstOrderOnly: coupon.firstOrderOnly ?? null,
    expiryDate: coupon.expiryDate?.toISOString() ?? null,
    targetMatch: analysis.targetMatch,
    potentialTargetMatch: analysis.potentialTargetMatch,
    uncertain: analysis.uncertain,
    uncertaintyReason: analysis.uncertaintyReason ?? null,
    discountAtTarget: analysis.discountAtTarget,
    finalPriceAtTarget: atTarget?.applicable ? analysis.finalPriceAtTarget : null,
    effectiveDiscountAtTarget: analysis.effectiveDiscountAtTarget,
    cartValueAnalysis: analysis.breakdowns.map((item) => ({
      cartValue: item.cartValue,
      discount: item.discount,
      finalPrice: item.finalPrice,
      effectiveDiscount: item.effectiveDiscount,
      applicable: item.applicable,
      reason: item.reason ?? null,
    })),
    independentSources: entry.independentSources,
    sourceCount: coupon.sourceCount,
    sources: coupon.sources.map((source) => ({
      name: source.name,
      url: source.url,
      type: source.type,
      discoveredAt: source.discoveredAt.toISOString(),
      lastSeenAt: source.lastSeenAt.toISOString(),
      reportedExpired: source.reportedExpired === true,
    })),
    firstSeenAt: coupon.firstSeenAt.toISOString(),
    lastSeenAt: coupon.lastSeenAt.toISOString(),
    lastValidatedAt: coupon.lastValidatedAt?.toISOString() ?? null,
    validationMethod: coupon.validationMethod ?? null,
    validationNotes: coupon.validationNotes ?? null,
    cartAcceptedAt: coupon.cartAcceptedAt?.toISOString() ?? null,
    officialConfirmedAt: coupon.officialConfirmedAt?.toISOString() ?? null,
    conflictingSources: coupon.conflictingSources,
  };
}

const CSV_COLUMNS: Array<[string, (coupon: SerialisedCoupon) => unknown]> = [
  ['code', (c) => c.code],
  ['title', (c) => c.title],
  ['status', (c) => c.status],
  ['confidence', (c) => c.confidence],
  ['discountType', (c) => c.discountType],
  ['discountValue', (c) => c.discountValue],
  ['isUpTo', (c) => c.isUpTo],
  ['minimumOrder', (c) => c.minimumOrder],
  ['minimumOrderKnown', (c) => c.minimumOrderKnown],
  ['maximumDiscount', (c) => c.maximumDiscount],
  ['discountAtTarget', (c) => c.discountAtTarget],
  ['finalPriceAtTarget', (c) => c.finalPriceAtTarget],
  ['effectiveDiscountAtTarget', (c) => c.effectiveDiscountAtTarget],
  ['targetMatch', (c) => c.targetMatch],
  ['potentialTargetMatch', (c) => c.potentialTargetMatch],
  ['uncertaintyReason', (c) => c.uncertaintyReason],
  ['newUsersOnly', (c) => c.newUsersOnly],
  ['appOnly', (c) => c.appOnly],
  ['selectedUsersOnly', (c) => c.selectedUsersOnly],
  ['selectedProductsOnly', (c) => c.selectedProductsOnly],
  ['firstOrderOnly', (c) => c.firstOrderOnly],
  ['expiryDate', (c) => c.expiryDate],
  ['firstSeenAt', (c) => c.firstSeenAt],
  ['lastSeenAt', (c) => c.lastSeenAt],
  ['lastValidatedAt', (c) => c.lastValidatedAt],
  ['validationMethod', (c) => c.validationMethod],
  ['validationNotes', (c) => c.validationNotes],
  ['sourceCount', (c) => c.sourceCount],
  ['independentSources', (c) => c.independentSources],
  ['sources', (c) => c.sources.map((source) => `${source.name}|${source.url}`).join(' ; ')],
];

export function toCsv(coupons: readonly SerialisedCoupon[]): string {
  const header = CSV_COLUMNS.map(([name]) => name).join(',');
  const rows = coupons.map((coupon) =>
    CSV_COLUMNS.map(([, accessor]) => csvCell(accessor(coupon))).join(','),
  );
  return [header, ...rows].join('\n') + '\n';
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}
