/** Process-wide runtime state shared by the scheduler and the reporters. */
export interface RuntimeState {
  startedAt: Date;
  lastScanStartedAt?: Date;
  lastScanCompletedAt?: Date;
  lastValidationCompletedAt?: Date;
  scanCount: number;
  validationCount: number;
  lastDiscoverySummary?: string;
  lastValidationSummary?: string;
}

export const runtimeState: RuntimeState = {
  startedAt: new Date(),
  scanCount: 0,
  validationCount: 0,
};
