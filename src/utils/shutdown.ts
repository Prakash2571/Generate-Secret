import { config } from '../config';
import { describeError, logger } from './logger';
import { humanDuration, withTimeout } from './time';

export interface ShutdownStep {
  name: string;
  run: () => Promise<void> | void;
  /** Per-step budget. The whole sequence is also bounded. */
  timeoutMs?: number;
}

/**
 * Tracks in-flight "safe" operations (a scan cycle, a validation batch) so
 * shutdown can wait briefly for them instead of killing them mid-write.
 */
export class OperationTracker {
  private readonly active = new Map<number, string>();
  private nextId = 1;

  begin(label: string): () => void {
    const id = this.nextId++;
    this.active.set(id, label);
    return () => {
      this.active.delete(id);
    };
  }

  get activeLabels(): string[] {
    return [...this.active.values()];
  }

  get count(): number {
    return this.active.size;
  }

  /** Waits for current operations, up to `maxWaitMs`. Never throws. */
  async drain(maxWaitMs: number): Promise<void> {
    const deadline = Date.now() + maxWaitMs;
    while (this.active.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (this.active.size > 0) {
      logger.warn('proceeding with shutdown while operations are still running', {
        pending: this.activeLabels.join(','),
      });
    }
  }
}

/**
 * Owns the graceful shutdown sequence.
 *
 * The abort signal is broadcast first so collectors/validators stop issuing new
 * work, then registered steps run in order. The sequence never starts new
 * discovery work.
 */
export class ShutdownManager {
  private readonly controller = new AbortController();
  private readonly steps: ShutdownStep[] = [];
  private shuttingDown = false;
  private sequence: Promise<number> | null = null;
  private signalCount = 0;

  readonly operations = new OperationTracker();

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  /** Steps run in registration order. */
  register(step: ShutdownStep): void {
    this.steps.push(step);
  }

  installSignalHandlers(): void {
    const onSignal = (signal: NodeJS.Signals): void => {
      this.signalCount += 1;
      if (this.signalCount > 1) {
        logger.warn('second signal received - exiting immediately', { signal });
        process.exit(130);
      }
      logger.raw('');
      logger.info('shutdown requested', { signal });
      void this.shutdown(signal).then((code) => process.exit(code));
    };

    process.on('SIGINT', () => onSignal('SIGINT'));
    process.on('SIGTERM', () => onSignal('SIGTERM'));
    // Docker/Compose may also send SIGHUP when the terminal detaches.
    process.on('SIGHUP', () => onSignal('SIGHUP'));

    process.on('uncaughtException', (error) => {
      logger.error('uncaught exception', { reason: describeError(error) });
      void this.shutdown('uncaughtException').then(() => process.exit(1));
    });
    process.on('unhandledRejection', (reason) => {
      logger.error('unhandled rejection', { reason: describeError(reason) });
      void this.shutdown('unhandledRejection').then(() => process.exit(1));
    });
  }

  /** Idempotent: concurrent callers await the same sequence. */
  shutdown(reason: string): Promise<number> {
    if (this.sequence) return this.sequence;
    this.shuttingDown = true;
    this.sequence = this.runSequence(reason);
    return this.sequence;
  }

  private async runSequence(reason: string): Promise<number> {
    const started = Date.now();

    // Hard stop so a hung resource can never keep the container alive past the
    // Compose stop_grace_period.
    const killTimer = setTimeout(() => {
      logger.error('shutdown exceeded its budget - forcing exit', {
        budgetMs: config.shutdownTimeoutMs,
      });
      process.exit(1);
    }, config.shutdownTimeoutMs);
    killTimer.unref?.();

    // Tell every in-flight network/browser operation to stop starting new work.
    this.controller.abort();

    let exitCode = 0;
    for (const step of this.steps) {
      const stepStarted = Date.now();
      try {
        await withTimeout(
          Promise.resolve(step.run()),
          step.timeoutMs ?? 10_000,
          `shutdown step "${step.name}"`,
        );
        logger.debug('shutdown step complete', {
          step: step.name,
          ms: Date.now() - stepStarted,
        });
      } catch (error) {
        exitCode = 1;
        logger.error('shutdown step failed', {
          step: step.name,
          reason: describeError(error),
        });
      }
    }

    clearTimeout(killTimer);
    logger.info('shutdown complete', {
      reason,
      took: humanDuration(Date.now() - started),
      exitCode,
    });
    return exitCode;
  }
}

export const shutdownManager = new ShutdownManager();
