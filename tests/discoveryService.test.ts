import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { collectors, enabledCollectors } from '../src/collectors';
import type { Collector, CollectorContext } from '../src/collectors/types';
import { dedupeWithinCycle, runCollector } from '../src/services/discoveryService';
import type { CouponCandidate } from '../src/types';
import { NOW } from './helpers/fixtures';

function candidate(overrides: Partial<CouponCandidate> = {}): CouponCandidate {
  return {
    discountType: 'flat',
    discountValue: 800,
    minimumOrder: 1000,
    isUpTo: false,
    minimumOrderKnown: true,
    rawText: 'Flat Rs.800 off on Rs.1000',
    source: {
      name: 'grabon',
      url: 'https://www.grabon.in/shein-coupons/',
      type: 'coupon-site',
      domain: 'grabon.in',
      discoveredAt: NOW,
      lastSeenAt: NOW,
    },
    ...overrides,
  };
}

function context(overrides: Partial<CollectorContext> = {}): CollectorContext {
  return {
    signal: new AbortController().signal,
    now: NOW,
    maxCandidates: 50,
    ...overrides,
  };
}

describe('collector registry', () => {
  it('registers every documented source', () => {
    const names = collectors.map((collector) => collector.name);
    for (const expected of [
      'officialShein',
      'searchEngine',
      'grabon',
      'coupondunia',
      'cashkaro',
      'desidime',
      'reddit',
      'generic',
    ]) {
      assert.ok(names.includes(expected), `missing collector: ${expected}`);
    }
  });

  it('lists official sources first, since their evidence outranks the rest', () => {
    assert.equal(collectors[0]?.sourceType, 'official');
  });

  it('describes every collector and filters on the enabled flag', () => {
    for (const collector of collectors) {
      assert.ok(collector.description.length > 0, `${collector.name} needs a description`);
      assert.equal(typeof collector.collect, 'function');
    }
    assert.ok(enabledCollectors().every((collector) => collector.enabled));
  });
});

describe('runCollector', () => {
  it('returns candidates from a healthy collector', async () => {
    const healthy: Collector = {
      name: 'healthy',
      sourceType: 'coupon-site',
      description: 'test',
      enabled: true,
      collect: async () => [candidate()],
    };

    const result = await runCollector(healthy, context());
    assert.equal(result.collector, 'healthy');
    assert.equal(result.candidates.length, 1);
    assert.deepEqual(result.errors, []);
    assert.ok(result.durationMs >= 0);
  });

  it('isolates a throwing collector instead of failing the scan', async () => {
    const broken: Collector = {
      name: 'broken',
      sourceType: 'coupon-site',
      description: 'test',
      enabled: true,
      collect: async () => {
        throw new Error('request timeout');
      },
    };

    const result = await runCollector(broken, context());
    assert.deepEqual(result.candidates, []);
    assert.equal(result.errors.length, 1);
    assert.match(String(result.errors[0]), /request timeout/);
  });

  it('isolates a synchronously throwing collector too', async () => {
    const broken: Collector = {
      name: 'broken-sync',
      sourceType: 'other',
      description: 'test',
      enabled: true,
      collect: () => {
        throw new Error('bad selector');
      },
    };

    const result = await runCollector(broken, context());
    assert.equal(result.errors.length, 1);
    assert.deepEqual(result.candidates, []);
  });
});

describe('dedupeWithinCycle', () => {
  it('collapses repeated claims from the same page', () => {
    const deduped = dedupeWithinCycle([
      candidate({ code: 'SHEIN800' }),
      candidate({ code: 'SHEIN800' }),
    ]);
    assert.equal(deduped.length, 1);
  });

  it('keeps the same code from different publishers so each becomes a source', () => {
    const deduped = dedupeWithinCycle([
      candidate({ code: 'SHEIN800' }),
      candidate({
        code: 'SHEIN800',
        source: {
          name: 'cashkaro',
          url: 'https://cashkaro.com/stores/shein',
          type: 'coupon-site',
          domain: 'cashkaro.com',
          discoveredAt: NOW,
          lastSeenAt: NOW,
        },
      }),
    ]);
    assert.equal(deduped.length, 2, 'both claims must survive to be merged into one coupon');
  });

  it('keeps the better-specified duplicate', () => {
    const vague = candidate({
      code: 'SHEIN800',
      minimumOrder: undefined,
      minimumOrderKnown: false,
    });
    const detailed = candidate({ code: 'SHEIN800', minimumOrder: 1000, minimumOrderKnown: true });

    const fromVagueFirst = dedupeWithinCycle([vague, detailed]);
    assert.equal(fromVagueFirst.length, 1);
    assert.equal(fromVagueFirst[0]?.minimumOrderKnown, true);

    const fromDetailedFirst = dedupeWithinCycle([detailed, vague]);
    assert.equal(fromDetailedFirst[0]?.minimumOrderKnown, true);
  });

  it('distinguishes different codes and code-less offers', () => {
    const deduped = dedupeWithinCycle([
      candidate({ code: 'SHEIN800' }),
      candidate({ code: 'NEW70' }),
      candidate({ code: undefined, title: 'sale', rawText: 'UP TO 80% OFF SALE' }),
    ]);
    assert.equal(deduped.length, 3);
  });

  it('handles an empty cycle', () => {
    assert.deepEqual(dedupeWithinCycle([]), []);
  });
});
