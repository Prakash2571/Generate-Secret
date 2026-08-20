import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DomainThrottle,
  Semaphore,
  createLimiter,
  mapWithConcurrency,
  safeDomain,
} from '../src/utils/concurrency';
import { describeError } from '../src/utils/logger';
import { isRetryableHttpFailure } from '../src/utils/httpClient';
import { HttpError, ChallengeError, detectChallenge } from '../src/utils/rawFetch';
import { AbortedError, withRetry } from '../src/utils/retry';
import { divider, renderTable } from '../src/utils/table';
import { formatIST, humanDuration, hoursSince, daysSince, sleep, withTimeout } from '../src/utils/time';
import './helpers/setup';

describe('renderTable', () => {
  it('renders a box table with consistent width and alignment', () => {
    const rendered = renderTable({
      head: ['CODE', 'OFFER', 'MINIMUM', '\u20b91000 PAY', 'STATUS', 'CONFIDENCE'],
      rows: [
        ['SHEIN800', '\u20b9800 OFF', '\u20b91000', '\u20b9200', 'VALID', '96'],
        ['NEW70', '70% OFF', '\u20b9999', '\u20b9300', 'VALID', '91'],
      ],
      align: ['left', 'left', 'right', 'right', 'left', 'right'],
    });

    const lines = rendered.split('\n');
    assert.equal(lines.length, 6, 'top, head, separator, two rows, bottom');
    assert.ok(lines[0]?.startsWith('\u250c'));
    assert.ok(lines[lines.length - 1]?.startsWith('\u2514'));

    const widths = new Set(lines.map((line) => [...line].length));
    assert.equal(widths.size, 1, 'every line must be the same width');

    // Right-aligned numeric column.
    assert.match(String(lines[3]), /\u20b9200 \u2502/);
  });

  it('shows a placeholder instead of an empty body', () => {
    const rendered = renderTable({ head: ['A', 'B'], rows: [] });
    assert.match(rendered, /\(none\)/);
    const widths = new Set(rendered.split('\n').map((line) => [...line].length));
    assert.equal(widths.size, 1);
  });

  it('ellipsises cells that exceed a maximum width', () => {
    const rendered = renderTable({
      head: ['CODE'],
      rows: [['THISCODEISFARTOOLONGTOSHOW']],
      maxWidths: [10],
    });
    assert.match(rendered, /THISCODEI\u2026/);
  });

  it('tolerates short rows', () => {
    const rendered = renderTable({ head: ['A', 'B', 'C'], rows: [['only-one']] });
    const widths = new Set(rendered.split('\n').map((line) => [...line].length));
    assert.equal(widths.size, 1);
  });

  it('divider is the expected width', () => {
    assert.equal(divider(10), '==========');
  });
});

describe('time helpers', () => {
  it('formats IST as the reports require', () => {
    assert.equal(formatIST(new Date('2026-08-19T15:00:00Z')), '2026-08-19 20:30 IST');
    assert.equal(formatIST(new Date('2026-01-01T00:00:00Z')), '2026-01-01 05:30 IST');
    assert.equal(formatIST(undefined), 'never');
    assert.equal(formatIST(null), 'never');
    assert.equal(formatIST(new Date('nonsense')), 'unknown');
  });

  it('measures elapsed time, treating absent dates as infinitely old', () => {
    const now = new Date('2026-08-19T15:00:00Z');
    assert.equal(hoursSince(new Date('2026-08-19T13:00:00Z'), now), 2);
    assert.equal(daysSince(new Date('2026-08-17T15:00:00Z'), now), 2);
    assert.equal(hoursSince(undefined, now), Number.POSITIVE_INFINITY);
  });

  it('formats durations for humans', () => {
    assert.equal(humanDuration(500), '500ms');
    assert.equal(humanDuration(1500), '1.5s');
    assert.equal(humanDuration(65_000), '1m05s');
  });

  it('sleep resolves immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const started = Date.now();
    await sleep(5000, controller.signal);
    assert.ok(Date.now() - started < 500, 'must not wait out the delay during shutdown');
  });

  it('sleep resolves early when the signal aborts mid-wait', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const started = Date.now();
    await sleep(5000, controller.signal);
    assert.ok(Date.now() - started < 1000);
  });

  it('withTimeout rejects a promise that overruns', async () => {
    await assert.rejects(
      () => withTimeout(new Promise((resolve) => setTimeout(resolve, 3000)), 50, 'slow task'),
      /slow task timed out after 50ms/,
    );
  });

  it('withTimeout passes a value through when it settles in time', async () => {
    assert.equal(await withTimeout(Promise.resolve('ok'), 1000, 'fast task'), 'ok');
  });
});

describe('concurrency', () => {
  it('Semaphore never exceeds its permit count', async () => {
    const semaphore = new Semaphore(2);
    let active = 0;
    let peak = 0;

    await Promise.all(
      Array.from({ length: 8 }, () =>
        semaphore.run(async () => {
          active += 1;
          peak = Math.max(peak, active);
          await sleep(20);
          active -= 1;
        }),
      ),
    );

    assert.equal(peak, 2);
    assert.equal(active, 0);
  });

  it('releases its permit even when the task throws', async () => {
    const semaphore = new Semaphore(1);
    await assert.rejects(() => semaphore.run(async () => { throw new Error('boom'); }));
    // If the permit leaked this would hang rather than resolve.
    assert.equal(await semaphore.run(async () => 'recovered'), 'recovered');
  });

  it('createLimiter bounds parallel work', async () => {
    const limit = createLimiter(1);
    const order: number[] = [];
    await Promise.all([
      limit(async () => {
        await sleep(30);
        order.push(1);
      }),
      limit(async () => {
        order.push(2);
      }),
    ]);
    assert.deepEqual(order, [1, 2], 'the second task must wait its turn');
  });

  it('mapWithConcurrency isolates per-item failures', async () => {
    const results = await mapWithConcurrency([1, 2, 3], 2, async (value) => {
      if (value === 2) throw new Error('item two failed');
      return value * 10;
    });

    assert.equal(results.length, 3);
    assert.deepEqual(results[0], { ok: true, value: 10 });
    assert.equal(results[1]?.ok, false);
    assert.deepEqual(results[2], { ok: true, value: 30 });
  });

  it('mapWithConcurrency handles an empty list', async () => {
    assert.deepEqual(await mapWithConcurrency([], 3, async () => 'x'), []);
  });

  it('DomainThrottle spaces out requests to the same host', async () => {
    const throttle = new DomainThrottle(120);
    const started = Date.now();
    await throttle.wait('https://example.com/a');
    await throttle.wait('https://example.com/b');
    assert.ok(Date.now() - started >= 100, 'second request must be delayed');
  });

  it('DomainThrottle does not penalise unrelated hosts', async () => {
    const throttle = new DomainThrottle(400);
    await throttle.wait('https://one.example/a');
    const started = Date.now();
    await throttle.wait('https://two.example/a');
    assert.ok(Date.now() - started < 300, 'a different domain must not wait');
  });

  it('safeDomain extracts hosts and tolerates junk', () => {
    assert.equal(safeDomain('https://www.grabon.in/shein-coupons/'), 'www.grabon.in');
    assert.equal(safeDomain('not a url'), 'unknown');
  });
});

describe('withRetry', () => {
  it('retries then succeeds', async () => {
    let attempts = 0;
    const value = await withRetry(
      async () => {
        attempts += 1;
        if (attempts < 3) throw new Error('transient');
        return 'done';
      },
      { retries: 3, label: 'test', baseDelayMs: 1 },
    );
    assert.equal(value, 'done');
    assert.equal(attempts, 3);
  });

  it('gives up after the configured number of retries', async () => {
    let attempts = 0;
    await assert.rejects(
      () =>
        withRetry(
          async () => {
            attempts += 1;
            throw new Error('always fails');
          },
          { retries: 2, label: 'test', baseDelayMs: 1 },
        ),
      /always fails/,
    );
    assert.equal(attempts, 3, 'one initial attempt plus two retries');
  });

  it('does not retry when the failure is not retryable', async () => {
    let attempts = 0;
    await assert.rejects(() =>
      withRetry(
        async () => {
          attempts += 1;
          throw new HttpError('HTTP 404 for x', 404, 'x');
        },
        { retries: 5, label: 'test', baseDelayMs: 1, isRetryable: isRetryableHttpFailure },
      ),
    );
    assert.equal(attempts, 1);
  });

  it('stops immediately when shutdown is requested', async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => withRetry(async () => 'never', { retries: 3, label: 'test', signal: controller.signal }),
      AbortedError,
    );
  });
});

describe('HTTP failure classification', () => {
  it('retries 429 and 5xx but not other 4xx', () => {
    assert.equal(isRetryableHttpFailure(new HttpError('x', 429, 'u')), true);
    assert.equal(isRetryableHttpFailure(new HttpError('x', 503, 'u')), true);
    assert.equal(isRetryableHttpFailure(new HttpError('x', 404, 'u')), false);
    assert.equal(isRetryableHttpFailure(new HttpError('x', 403, 'u')), false);
  });

  it('never retries an anti-bot challenge', () => {
    assert.equal(isRetryableHttpFailure(new ChallengeError('u', 'captcha')), false);
  });

  it('retries unknown transport errors', () => {
    assert.equal(isRetryableHttpFailure(new Error('socket hang up')), true);
  });
});

describe('detectChallenge', () => {
  it('detects the common protection pages', () => {
    assert.match(String(detectChallenge('<title>Just a moment...</title>', 200)), /cloudflare/);
    assert.match(String(detectChallenge('<div class="g-recaptcha"></div>', 200)), /captcha/);
    assert.match(String(detectChallenge('Verify you are human', 200)), /human/);
    assert.match(String(detectChallenge('captcha required', 403)), /captcha|block/);
  });

  it('does not cry wolf on ordinary pages', () => {
    assert.equal(detectChallenge('<html><body>SHEIN coupons</body></html>', 200), null);
  });
});

describe('describeError', () => {
  it('normalises anything throwable into a short string', () => {
    assert.equal(describeError(new Error('boom')), 'boom');
    assert.equal(describeError('plain string'), 'plain string');
    assert.equal(describeError({ code: 11000 }), '{"code":11000}');
    assert.ok(describeError(new Error('x'.repeat(500))).length <= 300);
  });
});
