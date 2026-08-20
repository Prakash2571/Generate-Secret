import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  countIndependentSources,
  normaliseDomain,
  scoreConfidence,
} from '../src/scoring/confidence';
import { NOW, daysAgo, hoursAgo, makeOfficialSource, makeSource } from './helpers/fixtures';

const score = (input: Parameters<typeof scoreConfidence>[0]): number =>
  scoreConfidence(input, NOW).score;

describe('scoreConfidence', () => {
  it('rewards a real cart acceptance most heavily', () => {
    const result = scoreConfidence(
      { sources: [makeSource()], lastSeenAt: NOW, conflictingSources: false, cartAcceptedAt: NOW },
      NOW,
    );
    // +50 cart, +10 seen within 24h
    assert.equal(result.score, 60);
    assert.ok(
      result.factors.some((factor) => /cart validation/.test(factor.label) && factor.points === 50),
    );
  });

  it('stops counting a stale cart acceptance as current evidence', () => {
    assert.equal(
      score({
        sources: [makeSource()],
        lastSeenAt: NOW,
        conflictingSources: false,
        cartAcceptedAt: hoursAgo(72),
      }),
      10,
    );
  });

  it('rewards a current official source', () => {
    // +35 official, +10 fresh
    assert.equal(
      score({ sources: [makeOfficialSource()], lastSeenAt: NOW, conflictingSources: false }),
      45,
    );
  });

  it('reaches 95 with cart acceptance, an official source and freshness', () => {
    assert.equal(
      score({
        sources: [makeOfficialSource()],
        lastSeenAt: NOW,
        conflictingSources: false,
        cartAcceptedAt: NOW,
      }),
      95,
    );
  });

  it('ignores an official source that has not been seen for over a week', () => {
    assert.equal(
      score({
        sources: [makeOfficialSource({ lastSeenAt: daysAgo(10) })],
        lastSeenAt: NOW,
        conflictingSources: false,
      }),
      10,
      'only the freshness bonus should remain',
    );
  });

  it('caps third-party corroboration so copies cannot look like proof', () => {
    const domains = ['grabon.in', 'coupondunia.in', 'cashkaro.com', 'site4.in', 'site5.in'];
    const sources = domains.map((domain) =>
      makeSource({ name: domain, domain, url: `https://${domain}/shein` }),
    );
    // +10 second, +5 third, +10 fresh = 25 regardless of how many more copy it.
    assert.equal(score({ sources, lastSeenAt: NOW, conflictingSources: false }), 25);
    assert.equal(
      score({ sources: sources.slice(0, 3), lastSeenAt: NOW, conflictingSources: false }),
      25,
      'the fourth and fifth copies must add nothing',
    );
  });

  it('gives a single third-party source almost no credit', () => {
    assert.equal(score({ sources: [makeSource()], lastSeenAt: NOW, conflictingSources: false }), 10);
  });

  it('applies the freshness ladder', () => {
    assert.equal(
      score({ sources: [makeSource()], lastSeenAt: hoursAgo(12), conflictingSources: false }),
      10,
    );
    assert.equal(
      score({ sources: [makeSource()], lastSeenAt: daysAgo(3), conflictingSources: false }),
      5,
    );
    assert.equal(
      score({ sources: [makeSource()], lastSeenAt: daysAgo(10), conflictingSources: false }),
      0,
    );
  });

  it('penalises staleness beyond 30 days', () => {
    const result = scoreConfidence(
      {
        sources: [makeOfficialSource({ lastSeenAt: NOW })],
        lastSeenAt: daysAgo(40),
        conflictingSources: false,
      },
      NOW,
    );
    // +35 official, -20 stale
    assert.equal(result.score, 15);
    assert.ok(result.factors.some((factor) => factor.points === -20));
  });

  it('penalises conflicting sources', () => {
    const conflicted = score({
      sources: [makeOfficialSource()],
      lastSeenAt: NOW,
      conflictingSources: true,
    });
    assert.equal(conflicted, 25, '45 minus the 20 point conflict penalty');
  });

  it('penalises expiry reports and past expiry dates', () => {
    const reported = scoreConfidence(
      {
        sources: [makeOfficialSource({ reportedExpired: true })],
        lastSeenAt: NOW,
        conflictingSources: false,
      },
      NOW,
    );
    assert.ok(reported.factors.some((factor) => factor.points === -50));

    const past = scoreConfidence(
      {
        sources: [makeOfficialSource()],
        lastSeenAt: NOW,
        conflictingSources: false,
        expiryDate: daysAgo(1),
      },
      NOW,
    );
    assert.ok(past.factors.some((factor) => /expiry/.test(factor.label) && factor.points === -50));
  });

  it('clamps the result to 0..100', () => {
    assert.equal(
      score({
        sources: [makeSource({ reportedExpired: true })],
        lastSeenAt: daysAgo(60),
        conflictingSources: true,
      }),
      0,
    );

    const maxed = score({
      sources: [
        makeOfficialSource(),
        makeSource({ domain: 'a.in', url: 'https://a.in/x' }),
        makeSource({ domain: 'b.in', url: 'https://b.in/x' }),
        makeSource({ domain: 'c.in', url: 'https://c.in/x' }),
      ],
      lastSeenAt: NOW,
      conflictingSources: false,
      cartAcceptedAt: NOW,
    });
    assert.ok(maxed <= 100);
    assert.equal(maxed, 100);
  });
});

describe('countIndependentSources', () => {
  it('counts distinct third-party domains only', () => {
    const sources = [
      makeOfficialSource(),
      makeSource({ domain: 'grabon.in', url: 'https://www.grabon.in/a' }),
      makeSource({ domain: 'grabon.in', url: 'https://www.grabon.in/b' }),
      makeSource({ domain: 'cashkaro.com', url: 'https://cashkaro.com/x' }),
    ];
    assert.equal(countIndependentSources(sources, NOW), 2);
  });

  it('ignores sources that have gone stale', () => {
    const sources = [
      makeSource({ domain: 'fresh.in', url: 'https://fresh.in/x' }),
      makeSource({ domain: 'old.in', url: 'https://old.in/x', lastSeenAt: daysAgo(45) }),
    ];
    assert.equal(countIndependentSources(sources, NOW), 1);
  });
});

describe('normaliseDomain', () => {
  it('collapses www, m, amp and mobile subdomains', () => {
    assert.equal(normaliseDomain('https://www.grabon.in/shein'), 'grabon.in');
    assert.equal(normaliseDomain('m.grabon.in'), 'grabon.in');
    assert.equal(normaliseDomain('amp.grabon.in'), 'grabon.in');
    assert.equal(normaliseDomain('https://GRABON.in/X'), 'grabon.in');
  });

  it('handles missing or malformed input', () => {
    assert.equal(normaliseDomain(undefined), '');
    assert.equal(normaliseDomain(''), '');
  });
});
