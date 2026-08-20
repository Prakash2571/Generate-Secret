import { collectors as allCollectors, enabledCollectors } from '../collectors';
import type { Collector, CollectorContext } from '../collectors/types';
import { config } from '../config';
import {
  buildDedupeKey,
  expirePastDueCoupons,
  refreshAllConfidence,
  upsertCandidate,
} from '../db/couponRepository';
import type { CollectorResult, CouponCandidate } from '../types';
import { mapWithConcurrency } from '../utils/concurrency';
import { describeError, logger } from '../utils/logger';
import { humanDuration, withTimeout } from '../utils/time';

/** One collector may not monopolise a cycle. */
const COLLECTOR_TIMEOUT_MS = 4 * 60_000;
/** Collectors run two at a time; the HTTP client still caps total requests. */
const COLLECTOR_CONCURRENCY = 2;

export interface DiscoveryStats {
  startedAt: Date;
  durationMs: number;
  collectorResults: CollectorResult[];
  totalCandidates: number;
  uniqueCandidates: number;
  newCoupons: number;
  updatedCoupons: number;
  changedCoupons: number;
  expiredCoupons: number;
  failedCollectors: string[];
}

/**
 * One discovery pass: run every collector, deduplicate, persist, rescore.
 *
 * A broken source can never break the scan - each collector is isolated with
 * its own try/catch and timeout, and its failure is reported as a log line.
 */
export async function runDiscovery(signal: AbortSignal): Promise<DiscoveryStats> {
  const startedAt = new Date();
  const started = Date.now();
  const collectors = enabledCollectors();

  logger.tag('INFO', 'Discovery started', {
    collectors: collectors.map((collector) => collector.name).join(','),
    disabled: disabledCollectorNames(),
  });

  const context: CollectorContext = {
    signal,
    now: startedAt,
    maxCandidates: config.maxCandidatesPerCollector,
  };

  const outcomes = await mapWithConcurrency(collectors, COLLECTOR_CONCURRENCY, (collector) =>
    runCollector(collector, context),
  );

  const collectorResults: CollectorResult[] = [];
  const failedCollectors: string[] = [];

  for (const [index, outcome] of outcomes.entries()) {
    const collector = collectors[index] as Collector;
    if (outcome.ok) {
      collectorResults.push(outcome.value);
      if (outcome.value.errors.length > 0) failedCollectors.push(collector.name);
    } else {
      // Should not happen (runCollector catches), but stay defensive.
      failedCollectors.push(collector.name);
      collectorResults.push({
        collector: collector.name,
        candidates: [],
        errors: [describeError(outcome.error)],
        durationMs: 0,
      });
      logger.error('collector failed unexpectedly', {
        collector: collector.name,
        reason: describeError(outcome.error),
      });
    }
  }

  const allCandidates = collectorResults.flatMap((result) => result.candidates);
  const candidates = dedupeWithinCycle(allCandidates);

  logger.tag('INFO', `Deduplicated: ${candidates.length} unique candidates`, {
    from: allCandidates.length,
  });

  // An empty scan is usually an environment problem, not an absence of offers.
  // Say why, instead of leaving the operator staring at an empty table.
  if (candidates.length === 0) {
    logger.warn('no candidate offers were extracted from any source this cycle', {
      failingCollectors: failedCollectors.length > 0 ? failedCollectors.join(',') : 'none',
      likelyCauses:
        'outbound HTTPS blocked; sources answered 403/anti-bot; robots.txt disallowed them; ' +
        'or no search key set (BRAVE_SEARCH_API_KEY / SERPAPI_KEY)',
      tip: 'set LOG_LEVEL=debug to see every request',
    });
  }

  let newCoupons = 0;
  let updatedCoupons = 0;
  let changedCoupons = 0;

  // Sequential writes: candidates frequently target the same document.
  for (const candidate of candidates) {
    if (signal.aborted) {
      logger.info('discovery persistence interrupted by shutdown', {
        remaining: candidates.length - (newCoupons + updatedCoupons),
      });
      break;
    }
    try {
      const result = await upsertCandidate(candidate, new Date());
      if (result.isNew) {
        newCoupons += 1;
        logger.tag('DISCOVERED', result.coupon.code ?? result.coupon.title ?? 'offer', {
          source: candidate.source.name,
          offer: describeCandidate(candidate),
        });
      } else {
        updatedCoupons += 1;
        if (result.changes.length > 0) {
          changedCoupons += 1;
          logger.tag('UPDATED', result.coupon.code ?? result.coupon.title ?? 'offer', {
            changes: result.changes.join('; '),
          });
        }
      }
    } catch (error) {
      logger.error('failed to persist candidate', {
        code: candidate.code,
        source: candidate.source.name,
        reason: describeError(error),
      });
    }
  }

  let expiredCoupons = 0;
  try {
    expiredCoupons = await expirePastDueCoupons(new Date());
    if (expiredCoupons > 0) logger.info('coupons marked expired', { count: expiredCoupons });
  } catch (error) {
    logger.warn('expiry sweep failed', { reason: describeError(error) });
  }

  try {
    // Confidence decays with age, so rescore everything each cycle.
    await refreshAllConfidence(new Date());
  } catch (error) {
    logger.warn('confidence refresh failed', { reason: describeError(error) });
  }

  const durationMs = Date.now() - started;
  logger.tag('INFO', 'MongoDB updated', {
    new: newCoupons,
    updated: updatedCoupons,
    changed: changedCoupons,
    took: humanDuration(durationMs),
  });

  return {
    startedAt,
    durationMs,
    collectorResults,
    totalCandidates: allCandidates.length,
    uniqueCandidates: candidates.length,
    newCoupons,
    updatedCoupons,
    changedCoupons,
    expiredCoupons,
    failedCollectors,
  };
}

/** Runs one collector in isolation: never throws, always reports. */
export async function runCollector(
  collector: Collector,
  context: CollectorContext,
): Promise<CollectorResult> {
  const started = Date.now();
  try {
    const candidates = await withTimeout(
      collector.collect(context),
      COLLECTOR_TIMEOUT_MS,
      `collector ${collector.name}`,
    );

    logger.tag('INFO', `${collector.name}: ${candidates.length} candidate offers`, {
      withCodes: candidates.filter((candidate) => candidate.code).length,
      took: humanDuration(Date.now() - started),
    });

    return {
      collector: collector.name,
      candidates,
      errors: [],
      durationMs: Date.now() - started,
    };
  } catch (error) {
    const reason = describeError(error);
    logger.error('collector failed', { collector: collector.name, reason });
    return {
      collector: collector.name,
      candidates: [],
      errors: [reason],
      durationMs: Date.now() - started,
    };
  }
}

/**
 * Collapses identical claims from the same page within one cycle.
 *
 * Claims about the same coupon from *different* sources are intentionally kept:
 * each becomes a source entry on the single stored coupon, which is what raises
 * confidence rather than creating duplicates.
 */
export function dedupeWithinCycle(candidates: readonly CouponCandidate[]): CouponCandidate[] {
  const seen = new Map<string, CouponCandidate>();

  for (const candidate of candidates) {
    const key = `${buildDedupeKey(candidate)}::${candidate.source.name}::${candidate.source.url}`;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, candidate);
      continue;
    }
    // Keep the better-specified duplicate.
    if (score(candidate) > score(existing)) seen.set(key, candidate);
  }

  return [...seen.values()];
}

function score(candidate: CouponCandidate): number {
  let value = 0;
  if (candidate.code) value += 4;
  if (candidate.discountValue !== undefined) value += 2;
  if (candidate.minimumOrderKnown) value += 2;
  if (candidate.expiryDate) value += 1;
  return value;
}

function describeCandidate(candidate: CouponCandidate): string {
  const parts: string[] = [candidate.discountType];
  if (candidate.discountValue !== undefined) parts.push(String(candidate.discountValue));
  if (candidate.minimumOrderKnown && candidate.minimumOrder !== undefined) {
    parts.push(`min ${candidate.minimumOrder}`);
  }
  if (candidate.isUpTo) parts.push('up-to');
  return parts.join(' ');
}

function disabledCollectorNames(): string {
  const names = allCollectors
    .filter((collector) => !collector.enabled)
    .map((collector) => collector.name);
  return names.length > 0 ? names.join(',') : 'none';
}
