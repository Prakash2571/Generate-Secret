import { browserManager } from './browser/BrowserManager';
import { assertConfig, config, redactMongoUrl } from './config';
import { countCoupons, countByStatus, countObservations } from './db/couponRepository';
import { connectMongo, disconnectMongo, syncIndexes } from './db/mongoose';
import {
  buildReport,
  printFinalReport,
  printScanSummary,
  writeReports,
  type ReportSnapshot,
} from './services/reportService';
import { Scheduler } from './services/scheduler';
import { runtimeState } from './services/state';
import { describeError, logger } from './utils/logger';
import { shutdownManager } from './utils/shutdown';
import { divider } from './utils/table';
import { formatIST } from './utils/time';

/** Snapshot produced during shutdown, shared between the report steps. */
let finalSnapshot: ReportSnapshot | undefined;

async function main(): Promise<void> {
  printBanner();
  assertConfig();

  // Signals are handled before any resource is opened, so Ctrl+C is honoured
  // even during startup.
  shutdownManager.installSignalHandlers();

  await connectMongo();
  await syncIndexes();

  // "Load existing coupons": report what history we already have.
  const [existing, observations, byStatus] = await Promise.all([
    countCoupons(),
    countObservations(),
    countByStatus(),
  ]);
  logger.info('existing coupon history loaded', {
    coupons: existing,
    observations,
    valid: byStatus.valid ?? 0,
    unverified: byStatus.unverified ?? 0,
    manual: byStatus.manual_validation_required ?? 0,
    invalid: byStatus.invalid ?? 0,
    expired: byStatus.expired ?? 0,
  });

  const scheduler = new Scheduler(shutdownManager.signal);
  registerShutdownSteps(scheduler);

  if (config.reportOnly) {
    logger.info('REPORT_ONLY set: printing stored state without scanning');
    const snapshot = await buildReport(new Date());
    printScanSummary(snapshot);
    await writeReports(snapshot);
    process.exit(await shutdownManager.shutdown('report-only complete'));
  }

  await scheduler.runInitialCycle();

  if (config.runOnce) {
    logger.info('RUN_ONCE set: single cycle complete');
    process.exit(await shutdownManager.shutdown('run-once complete'));
  }

  scheduler.start();
}

/**
 * Shutdown sequence (specification sections 5 and 27), in order:
 *   stop scheduling -> let safe work finish -> close browsers ->
 *   read MongoDB -> print report -> write JSON -> write CSV -> close MongoDB
 *
 * It never starts a new scan and is bounded by SHUTDOWN_TIMEOUT_MS.
 */
function registerShutdownSteps(scheduler: Scheduler): void {
  shutdownManager.register({
    name: 'stop scheduling new scans',
    timeoutMs: 2000,
    run: () => scheduler.stop(),
  });

  shutdownManager.register({
    name: 'allow current safe operations to finish',
    timeoutMs: 9000,
    run: async () => {
      if (shutdownManager.operations.count === 0) return;
      logger.info('waiting for in-flight operations', {
        pending: shutdownManager.operations.activeLabels.join(','),
      });
      await shutdownManager.operations.drain(8000);
    },
  });

  shutdownManager.register({
    name: 'close playwright browsers',
    timeoutMs: 15_000,
    run: () => browserManager.close(),
  });

  shutdownManager.register({
    name: 'fetch and print final valid coupons',
    timeoutMs: 12_000,
    run: async () => {
      finalSnapshot = await buildReport(new Date());
      printFinalReport(finalSnapshot);
    },
  });

  shutdownManager.register({
    name: 'write final JSON and CSV reports',
    timeoutMs: 10_000,
    run: async () => {
      if (!finalSnapshot) return;
      await writeReports(finalSnapshot);
    },
  });

  shutdownManager.register({
    name: 'close mongodb',
    timeoutMs: 8000,
    run: () => disconnectMongo(),
  });
}

function printBanner(): void {
  const line = divider(52);
  logger.raw(line);
  logger.raw('SHEIN INDIA PUBLIC COUPON DISCOVERY & VALIDATION');
  logger.raw(line);
  logger.raw(`Started: ${formatIST(runtimeState.startedAt)}`);
  logger.raw(`MongoDB: ${redactMongoUrl(config.mongoUrl || '(unset)')} db=${config.mongoDb}`);
  logger.raw(
    `Target: \u20b9${config.targetDiscount} off \u20b9${config.targetCartValue} ` +
      `(~${Math.round((config.targetDiscount / config.targetCartValue) * 100)}% effective)`,
  );
  logger.raw(
    `Schedule: discovery every ${config.scanIntervalMinutes}m, ` +
      `validation every ${config.validationIntervalMinutes}m`,
  );
  logger.raw(
    `Politeness: max ${config.maxConcurrentRequests} concurrent requests, ` +
      `${config.requestDelayMs}ms per-domain delay, robots.txt respected`,
  );
  logger.raw(
    'Policy: public sources only; no code brute-forcing, no CAPTCHA/anti-bot bypass, ' +
      'no fake accounts, no orders, no payment details.',
  );
  logger.raw(line);
  logger.raw('');
}

void main().catch(async (error) => {
  logger.error('fatal startup error', { reason: describeError(error) });
  try {
    const code = await shutdownManager.shutdown('startup failure');
    process.exit(code === 0 ? 1 : code);
  } catch {
    process.exit(1);
  }
});
