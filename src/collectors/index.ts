import { cashKaroCollector } from './cashKaro';
import { couponDuniaCollector } from './couponDunia';
import { desiDimeCollector } from './desiDime';
import { genericCollector } from './genericCouponPage';
import { grabonCollector } from './grabon';
import { officialSheinCollector } from './officialShein';
import { redditCollector } from './reddit';
import { searchEngineCollector } from './searchEngine';
import type { Collector } from './types';

/**
 * Collector registry.
 *
 * Order matters only for logging; discovery runs them with bounded concurrency
 * and isolates failures. Official sources are listed first because their
 * evidence outranks third-party claims during validation.
 *
 * To add a source: create `src/collectors/<name>.ts` exporting a `Collector`
 * (usually via `createCouponSiteCollector`) and add it here.
 */
export const collectors: Collector[] = [
  officialSheinCollector,
  searchEngineCollector,
  grabonCollector,
  couponDuniaCollector,
  cashKaroCollector,
  desiDimeCollector,
  redditCollector,
  genericCollector,
];

export function enabledCollectors(): Collector[] {
  return collectors.filter((collector) => collector.enabled);
}

export type { Collector, CollectorContext } from './types';
