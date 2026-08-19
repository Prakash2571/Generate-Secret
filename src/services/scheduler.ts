import { config } from '../config';
import { describeError, logger } from '../utils/logger';
import { shutdownManager } from '../utils/shutdown';
import { MINUTE_MS, humanDuration } from '../utils/time';
import { runDiscovery } from './discoveryService';
import { buildReport, printScanSummary, writeReports } from './reportService';
import { runtimeState } from './state';
import { runValidation } from './validationService';

/**
 * Periodic job runner.
 *
 * Two independent schedules (discovery and validation) with per-job locks: if a
 * previous run is still going, the scheduled run is skipped rather than queued,
 * so slow cycles can never pile up on top of each other.
 */
export class Scheduler {
  private discoveryRunning = false;
  private validationRunning = false;
  private stopped = false;
  private readonly timers: NodeJS.Timeout[] = [];

  constructor(private readonly signal: AbortSignal) {}

  /** Full pass used at boot and for RUN_ONCE. */
  async runInitialCycle(): Promise<void> {
    await this.discoveryCycle();
    await this.validationCycle();
    await this.publishReports();
  }

  start(): void {
    if (this.stopped) return;

    const discoveryInterval = config.scanIntervalMinutes * MINUTE_MS;
    const validationInterval = config.validationIntervalMinutes * MINUTE_MS;

    this.timers.push(
      setInterval(() => {
        void this.discoveryCycle().then(() => this.publishReports());
      }, discoveryInterval),
    );

    this.timers.push(
      setInterval(() => {
        void this.validationCycle().then(() => this.publishReports());
      }, validationInterval),
    );

    logger.info('scheduler started', {
      discoveryEveryMinutes: config.scanIntervalMinutes,
      validationEveryMinutes: config.validationIntervalMinutes,
    });
    logger.info(
      `sleeping until the next scheduled scan (in ${humanDuration(discoveryInterval)}) - press Ctrl+C to stop`,
    );
  }

  /** Stops scheduling new work. In-flight work is left to finish. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const timer of this.timers) clearInterval(timer);
    this.timers.length = 0;
    logger.info('scheduler stopped: no new scans will be started');
  }

  get isBusy(): boolean {
    return this.discoveryRunning || this.validationRunning;
  }

  private async discoveryCycle(): Promise<void> {
    if (this.stopped || this.signal.aborted) return;
    if (this.discoveryRunning) {
      logger.warn('skipping scheduled discovery: previous run is still in progress');
      return;
    }

    this.discoveryRunning = true;
    const finish = shutdownManager.operations.begin('discovery');
    runtimeState.lastScanStartedAt = new Date();

    try {
      const stats = await runDiscovery(this.signal);
      runtimeState.scanCount += 1;
      runtimeState.lastScanCompletedAt = new Date();
      runtimeState.lastDiscoverySummary =
        `${stats.uniqueCandidates} candidates, ${stats.newCoupons} new, ` +
        `${stats.updatedCoupons} updated, ${stats.failedCollectors.length} failing collectors`;
    } catch (error) {
      logger.error('discovery cycle failed', { reason: describeError(error) });
    } finally {
      finish();
      this.discoveryRunning = false;
    }
  }

  private async validationCycle(): Promise<void> {
    if (this.stopped || this.signal.aborted) return;
    if (this.validationRunning) {
      logger.warn('skipping scheduled validation: previous run is still in progress');
      return;
    }

    this.validationRunning = true;
    const finish = shutdownManager.operations.begin('validation');

    try {
      const stats = await runValidation(this.signal);
      runtimeState.validationCount += 1;
      runtimeState.lastValidationCompletedAt = new Date();
      runtimeState.lastValidationSummary =
        `${stats.attempted} checked, ${stats.results.valid} valid, ` +
        `${stats.results.invalid} invalid, ${stats.results.manual_validation_required} manual`;
    } catch (error) {
      logger.error('validation cycle failed', { reason: describeError(error) });
    } finally {
      finish();
      this.validationRunning = false;
    }
  }

  /** Prints the CLI table and refreshes the files under results/. */
  private async publishReports(): Promise<void> {
    if (this.signal.aborted) return;
    try {
      const snapshot = await buildReport(new Date());
      printScanSummary(snapshot);
      await writeReports(snapshot);
    } catch (error) {
      logger.error('failed to publish reports', { reason: describeError(error) });
    }
  }
}
