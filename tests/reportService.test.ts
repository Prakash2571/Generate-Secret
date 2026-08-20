import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { ICoupon } from '../src/db/models/Coupon';
import {
  buildReport,
  printFinalReport,
  printScanSummary,
  serialiseReport,
  toCsv,
  writeReports,
  type ReportSnapshot,
} from '../src/services/reportService';
import { runtimeState } from '../src/services/state';
import { NOW, captureStdout, makeCoupon, makeOfficialSource, makeSource } from './helpers/fixtures';

const FIXTURES: ICoupon[] = [
  makeCoupon({
    code: 'SHEIN800',
    title: 'Flat Rs.800 off on Rs.1000',
    discountValue: 800,
    minimumOrder: 1000,
    status: 'valid',
    confidence: 96,
    newUsersOnly: true,
    hasOfficialSource: true,
    officialConfirmedAt: NOW,
    cartAcceptedAt: NOW,
    sources: [makeOfficialSource()],
    validationMethod: 'official-publication',
    lastValidatedAt: NOW,
    dedupeKey: 'CODE:SHEIN800',
  }),
  makeCoupon({
    code: 'NEW70',
    discountType: 'percentage',
    discountValue: 70,
    maximumDiscount: 700,
    minimumOrder: 999,
    status: 'valid',
    confidence: 91,
    lastValidatedAt: NOW,
    dedupeKey: 'CODE:NEW70',
  }),
  makeCoupon({
    code: 'APPONLY60',
    discountType: 'percentage',
    discountValue: 60,
    maximumDiscount: 300,
    minimumOrder: 1000,
    status: 'manual_validation_required',
    confidence: 55,
    appOnly: true,
    selectedUsersOnly: true,
    validationMethod: 'cart-coupon-field',
    validationNotes: 'sign-in requested; validation stops here by policy',
    dedupeKey: 'CODE:APPONLY60',
  }),
  makeCoupon({
    code: undefined,
    title: 'UP TO 80% OFF SALE',
    discountType: 'sale',
    discountValue: 80,
    isUpTo: true,
    minimumOrder: undefined,
    minimumOrderKnown: false,
    status: 'unverified',
    confidence: 25,
    sources: [
      makeSource({ domain: 'grabon.in', url: 'https://grabon.in/a' }),
      makeSource({ domain: 'cashkaro.com', url: 'https://cashkaro.com/a' }),
    ],
    sourceCount: 2,
    validationMethod: 'public-sources-only',
    dedupeKey: 'OFFER:sale80',
  }),
  makeCoupon({
    code: 'OLD500',
    discountValue: 500,
    minimumOrder: 1500,
    status: 'expired',
    confidence: 0,
    expiryDate: new Date('2026-07-01T00:00:00Z'),
    dedupeKey: 'CODE:OLD500',
  }),
];

const load = (coupons: ICoupon[] = FIXTURES) => async (): Promise<ICoupon[]> => coupons;

let snapshot: ReportSnapshot;
let temporaryDirectory: string;

before(async () => {
  runtimeState.lastScanCompletedAt = NOW;
  runtimeState.scanCount = 3;
  snapshot = await buildReport(NOW, { load: load() });
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'shein-reports-'));
});

after(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

describe('buildReport', () => {
  it('groups coupons by status without mixing them', () => {
    assert.equal(snapshot.counts.total, 5);
    assert.equal(snapshot.counts.valid, 2);
    assert.equal(snapshot.counts.manual_validation_required, 1);
    assert.equal(snapshot.counts.unverified, 1);
    assert.equal(snapshot.counts.expired, 1);
    assert.equal(snapshot.counts.invalid, 0);

    for (const [status, entries] of Object.entries(snapshot.groups)) {
      assert.ok(
        entries.every((entry) => entry.coupon.status === status),
        `group ${status} contains a foreign status`,
      );
    }
  });

  it('sorts valid coupons by the cheapest payable price on the target cart', () => {
    assert.deepEqual(
      snapshot.valid.map((entry) => entry.coupon.code),
      ['SHEIN800', 'NEW70'],
    );
    assert.equal(snapshot.valid[0]?.analysis.finalPriceAtTarget, 200);
    assert.equal(snapshot.valid[1]?.analysis.finalPriceAtTarget, 300);
  });

  it('tags only the provable target hit and picks it as best', () => {
    assert.deepEqual(
      snapshot.targetMatches.map((entry) => entry.coupon.code),
      ['SHEIN800'],
    );
    assert.equal(snapshot.best?.coupon.code, 'SHEIN800');
  });

  it('chooses the best coupon only from verified valid ones', async () => {
    const withoutValid = await buildReport(NOW, {
      load: load(FIXTURES.filter((coupon) => coupon.status !== 'valid')),
    });
    assert.equal(withoutValid.best, undefined);
  });
});

describe('printFinalReport', () => {
  it('prints each status group under its own heading, in order', async () => {
    const output = await captureStdout(() => printFinalReport(snapshot));

    for (const heading of [
      'SHEIN INDIA COUPON FINDER \u2014 FINAL REPORT',
      'VERIFIED VALID',
      'MANUAL VALIDATION REQUIRED',
      'UNVERIFIED',
      'BEST COUPON',
    ]) {
      assert.ok(output.includes(heading), `missing heading: ${heading}`);
    }

    assert.ok(output.indexOf('VERIFIED VALID') < output.indexOf('MANUAL VALIDATION REQUIRED'));
    assert.ok(output.indexOf('MANUAL VALIDATION REQUIRED') < output.indexOf('UNVERIFIED'));
    assert.ok(output.indexOf('UNVERIFIED') < output.indexOf('BEST COUPON'));
  });

  it('prints the required detail lines for a valid coupon', async () => {
    const output = await captureStdout(() => printFinalReport(snapshot));

    assert.ok(output.includes('Last scan: 2026-08-19 20:30 IST'));
    assert.ok(output.includes('Valid coupons: 2'));
    assert.ok(output.includes('1. SHEIN800'));
    assert.ok(output.includes('Discount: \u20b9800'));
    assert.ok(output.includes('Minimum purchase: \u20b91,000'));
    assert.ok(output.includes('Final amount on \u20b91,000: \u20b9200'));
    assert.ok(output.includes('New users: YES'));
    assert.ok(output.includes('India: YES'));
    assert.ok(output.includes('Status: VALID'));
    assert.ok(output.includes('Confidence: 96/100'));
    assert.ok(output.includes('Tag: TARGET_MATCH'));
  });

  it('shows a percentage coupon with its cap', async () => {
    const output = await captureStdout(() => printFinalReport(snapshot));
    assert.ok(output.includes('2. NEW70'));
    assert.ok(output.includes('Discount: 70%'));
    assert.ok(output.includes('Maximum discount: \u20b9700'));
  });

  it('fills in the best-coupon block', async () => {
    const output = await captureStdout(() => printFinalReport(snapshot));
    const best = output.slice(output.indexOf('BEST COUPON'));

    assert.ok(best.includes('Code: SHEIN800'));
    assert.ok(best.includes('Expected payment on \u20b91,000: \u20b9200'));
    assert.ok(best.includes('New user only: YES'));
    assert.ok(best.includes('Expiry: not published'));
    assert.ok(best.includes('Last validated: 2026-08-19 20:30 IST'));
    assert.ok(best.includes('Confidence: 96/100'));
    assert.ok(best.includes('Sources: officialShein(official)'));
  });

  it('says so plainly when nothing is verified', async () => {
    const empty = await buildReport(NOW, {
      load: load(FIXTURES.filter((coupon) => coupon.status !== 'valid')),
    });
    const output = await captureStdout(() => printFinalReport(empty));

    assert.ok(output.includes('No currently verified SHEIN India coupons were found.'));
    assert.ok(output.includes('No verified valid coupon is available to recommend.'));
    assert.ok(!output.includes('Valid coupons: '), 'must not print an empty valid list');
  });

  it('explains why nothing reaches the target, and lists near misses', async () => {
    const nearMiss = await buildReport(NOW, {
      load: load([
        makeCoupon({
          code: 'MAYBE800',
          discountValue: 800,
          minimumOrder: undefined,
          minimumOrderKnown: false,
          status: 'unverified',
        }),
      ]),
    });
    const output = await captureStdout(() => printFinalReport(nearMiss));

    assert.ok(output.includes('No verified coupon currently delivers'));
    assert.ok(output.includes('MAYBE800'));
    assert.match(output, /would reach the target if their/);
  });
});

describe('printScanSummary', () => {
  it('prints a table of actionable coupons plus a status summary', async () => {
    const output = await captureStdout(() => printScanSummary(snapshot));

    assert.ok(output.includes('SHEIN800'));
    assert.ok(output.includes('*TARGET*'));
    assert.ok(output.includes('\u20b9200'));
    assert.ok(output.includes('CONFIDENCE'));
    assert.match(output, /Coupons: 5 \(valid=2/);
    assert.match(output, /TARGET_MATCH: 1/);
  });

  it('falls back to the most promising rows when nothing is actionable', async () => {
    const onlyExpired = await buildReport(NOW, {
      load: load(FIXTURES.filter((coupon) => coupon.status === 'expired')),
    });
    const output = await captureStdout(() => printScanSummary(onlyExpired));
    assert.ok(output.includes('OLD500'), 'the operator still needs to see something');
  });
});

describe('serialiseReport', () => {
  it('captures the analysis, lineage and target metadata', () => {
    const serialised = serialiseReport(snapshot);

    assert.equal(serialised.coupons.length, 5);
    assert.equal(serialised.target.cartValue, 1000);
    assert.equal(serialised.target.discount, 800);
    assert.deepEqual(serialised.target.cartValueLadder, [999, 1000, 1099, 1199, 1299, 1499, 1999]);
    assert.equal(serialised.best?.code, 'SHEIN800');
    assert.equal(serialised.targetMatches.length, 1);
    assert.equal(serialised.generatedAtIST, '2026-08-19 20:30 IST');

    const best = serialised.coupons.find((coupon) => coupon.code === 'SHEIN800');
    assert.equal(best?.finalPriceAtTarget, 200);
    assert.equal(best?.effectiveDiscountAtTarget, 0.8);
    assert.equal(best?.cartValueAnalysis.length, 7);
    assert.equal(best?.sources[0]?.type, 'official');
    assert.ok((best?.confidenceFactors.length ?? 0) > 0, 'confidence must be explainable');
  });

  it('reports no payable price for an offer that cannot be applied', () => {
    const serialised = serialiseReport(snapshot);
    const sale = serialised.coupons.find((coupon) => coupon.title === 'UP TO 80% OFF SALE');

    assert.equal(sale?.finalPriceAtTarget, null);
    assert.equal(sale?.targetMatch, false);
    assert.equal(sale?.isUpTo, true);
    assert.equal(sale?.minimumOrderKnown, false);
    // "up to" is reported first: it is the strongest reason the value is unknown.
    assert.match(String(sale?.uncertaintyReason), /up to/);
  });

  it('is JSON-serialisable with no live Date or Mongoose objects', () => {
    const json = JSON.stringify(serialiseReport(snapshot));
    const parsed = JSON.parse(json);
    assert.equal(typeof parsed.coupons[0].firstSeenAt, 'string');
    assert.equal(parsed.coupons.length, 5);
  });
});

describe('toCsv', () => {
  it('writes a header plus one row per coupon', () => {
    const lines = toCsv(serialiseReport(snapshot).coupons).trim().split('\n');
    assert.equal(lines.length, 6);
    assert.match(String(lines[0]), /^code,title,status,confidence,discountType/);
    assert.ok(String(lines[0]).includes('finalPriceAtTarget'));
    assert.ok(String(lines[0]).includes('targetMatch'));
  });

  it('quotes and escapes values containing commas, quotes or newlines', () => {
    const [coupon] = serialiseReport(snapshot).coupons;
    assert.ok(coupon);
    const csv = toCsv([
      { ...coupon, title: 'Flat 800, valid "today"\nonly', code: 'X,Y' },
    ]);
    const row = csv.trim().split('\n')[1] as string;
    assert.ok(row.includes('"X,Y"'));
    assert.ok(row.includes('""today""'), 'inner quotes must be doubled');
  });

  it('produces just a header for an empty list', () => {
    assert.equal(toCsv([]).trim().split('\n').length, 1);
  });
});

describe('writeReports', () => {
  it('writes all four files into the target directory', async () => {
    await writeReports(snapshot, temporaryDirectory);

    const files = await fs.readdir(temporaryDirectory);
    for (const expected of [
      'latest.json',
      'latest.csv',
      'valid-coupons.json',
      'valid-coupons.csv',
    ]) {
      assert.ok(files.includes(expected), `missing ${expected}`);
    }
  });

  it('limits the valid-only files to verified valid coupons', async () => {
    await writeReports(snapshot, temporaryDirectory);

    const parsed = JSON.parse(
      await fs.readFile(path.join(temporaryDirectory, 'valid-coupons.json'), 'utf8'),
    );
    assert.equal(parsed.coupons.length, 2);
    assert.ok(parsed.coupons.every((coupon: { status: string }) => coupon.status === 'valid'));
    assert.match(parsed.note, /official publication or an actual/);

    const csv = await fs.readFile(path.join(temporaryDirectory, 'valid-coupons.csv'), 'utf8');
    assert.equal(csv.trim().split('\n').length, 3, 'header plus two valid coupons');
  });

  it('creates the directory when it does not exist yet', async () => {
    const nested = path.join(temporaryDirectory, 'deep', 'nested');
    await writeReports(snapshot, nested);
    assert.ok((await fs.readdir(nested)).includes('latest.json'));
  });

  it('does not throw when the directory cannot be written', async () => {
    // A path under a file can never be a directory: this must be survived, not fatal.
    const filePath = path.join(temporaryDirectory, 'latest.json');
    await writeReports(snapshot, path.join(filePath, 'impossible'));
  });
});
