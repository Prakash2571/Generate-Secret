import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { matchesRobotsPattern, parseRobots } from '../src/utils/robots';
import './helpers/setup';

describe('parseRobots', () => {
  it('reads rules from the wildcard group', () => {
    const rules = parseRobots(['User-agent: *', 'Disallow: /private', 'Allow: /private/public'].join('\n'));
    assert.deepEqual(rules.disallow, ['/private']);
    assert.deepEqual(rules.allow, ['/private/public']);
  });

  it('ignores groups aimed at other crawlers', () => {
    const rules = parseRobots(
      ['User-agent: Googlebot', 'Disallow: /', '', 'User-agent: *', 'Disallow: /search'].join('\n'),
    );
    assert.deepEqual(rules.disallow, ['/search'], 'only the wildcard group applies to us');
  });

  it('applies rules shared by consecutive user-agent lines', () => {
    const rules = parseRobots(
      ['User-agent: SomeBot', 'User-agent: *', 'Disallow: /shared'].join('\n'),
    );
    assert.deepEqual(rules.disallow, ['/shared']);
  });

  it('honours a group naming this crawler explicitly', () => {
    const rules = parseRobots(['User-agent: SheinCouponFinder', 'Disallow: /nope'].join('\n'));
    assert.deepEqual(rules.disallow, ['/nope']);
  });

  it('reads and bounds Crawl-delay', () => {
    assert.equal(parseRobots(['User-agent: *', 'Crawl-delay: 5'].join('\n')).crawlDelayMs, 5000);
    assert.equal(
      parseRobots(['User-agent: *', 'Crawl-delay: 600'].join('\n')).crawlDelayMs,
      30_000,
      'an absurd delay is capped so a scan cannot stall forever',
    );
    assert.equal(parseRobots(['User-agent: *', 'Crawl-delay: nonsense'].join('\n')).crawlDelayMs, undefined);
  });

  it('ignores comments, blank lines and empty values', () => {
    const rules = parseRobots(
      ['# a comment', 'User-agent: *', 'Disallow: /x # trailing comment', 'Disallow:', ''].join('\n'),
    );
    assert.deepEqual(rules.disallow, ['/x']);
  });

  it('survives an empty or malformed file', () => {
    assert.deepEqual(parseRobots('').disallow, []);
    assert.deepEqual(parseRobots('total nonsense without colons').disallow, []);
  });
});

describe('matchesRobotsPattern', () => {
  it('matches by prefix', () => {
    assert.equal(matchesRobotsPattern('/private/page', '/private'), true);
    assert.equal(matchesRobotsPattern('/public/page', '/private'), false);
  });

  it('supports the * wildcard', () => {
    assert.equal(matchesRobotsPattern('/a/b/c.html', '/a/*/c.html'), true);
    assert.equal(matchesRobotsPattern('/search?q=shein', '/*?q='), true);
  });

  it('supports the $ end anchor', () => {
    assert.equal(matchesRobotsPattern('/page.html', '/page.html$'), true);
    assert.equal(matchesRobotsPattern('/page.html?a=1', '/page.html$'), false);
  });

  it('treats an empty pattern as matching nothing', () => {
    assert.equal(matchesRobotsPattern('/anything', ''), false);
  });

  it('escapes regex metacharacters in paths', () => {
    assert.equal(matchesRobotsPattern('/a+b', '/a+b'), true);
    assert.equal(matchesRobotsPattern('/aab', '/a+b'), false);
  });
});
