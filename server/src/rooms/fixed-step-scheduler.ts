export interface FixedStepSchedulerOptions {
  fixedStepSeconds: number;
  maxFrameDeltaSeconds: number;
  maxSubsteps: number;
  snapshotIntervalMs: number;
}

export interface FixedStepFrame {
  fixedSteps: number;
  clampedDeltaMs: number;
  droppedTimeMs: number;
  snapshotDue: boolean;
  simulationTimeMs: number;
}

/**
 * Converts jittery callback elapsed time into bounded, exact fixed substeps and
 * an independent snapshot cadence. Raw frame delta never reaches simulation.
 */
export class FixedStepScheduler {
  private accumulatorSeconds = 0;
  private snapshotElapsedMs = 0;
  private firstSnapshotPending = true;
  private elapsedSimulationMs = 0;

  constructor(private readonly options: FixedStepSchedulerOptions) {
    if (!(options.fixedStepSeconds > 0)) throw new Error('fixedStepSeconds must be positive');
    if (!(options.maxFrameDeltaSeconds > 0)) throw new Error('maxFrameDeltaSeconds must be positive');
    if (!(options.maxSubsteps >= 1)) throw new Error('maxSubsteps must be at least one');
    if (!(options.snapshotIntervalMs > 0)) throw new Error('snapshotIntervalMs must be positive');
  }

  get simulationTimeMs(): number {
    return this.elapsedSimulationMs;
  }

  advance(rawDeltaMs: number): FixedStepFrame {
    const safeDeltaMs = Number.isFinite(rawDeltaMs) ? Math.max(rawDeltaMs, 0) : 0;
    const clampedDeltaMs = Math.min(
      safeDeltaMs,
      this.options.maxFrameDeltaSeconds * 1000,
    );
    this.accumulatorSeconds += clampedDeltaMs / 1000;

    const epsilon = this.options.fixedStepSeconds * 1e-9;
    const availableSteps = Math.floor(
      (this.accumulatorSeconds + epsilon) / this.options.fixedStepSeconds,
    );
    const fixedSteps = Math.min(availableSteps, Math.floor(this.options.maxSubsteps));
    this.accumulatorSeconds = Math.max(
      0,
      this.accumulatorSeconds - fixedSteps * this.options.fixedStepSeconds,
    );

    let droppedTimeMs = 0;
    if (availableSteps > fixedSteps) {
      const droppedSteps = Math.floor(
        (this.accumulatorSeconds + epsilon) / this.options.fixedStepSeconds,
      );
      const droppedSeconds = droppedSteps * this.options.fixedStepSeconds;
      this.accumulatorSeconds = Math.max(0, this.accumulatorSeconds - droppedSeconds);
      droppedTimeMs = droppedSeconds * 1000;
    }

    this.elapsedSimulationMs += fixedSteps * this.options.fixedStepSeconds * 1000;
    this.snapshotElapsedMs += clampedDeltaMs;

    let snapshotDue = this.firstSnapshotPending;
    if (this.firstSnapshotPending) {
      this.firstSnapshotPending = false;
      this.snapshotElapsedMs = 0;
    } else if (this.snapshotElapsedMs >= this.options.snapshotIntervalMs) {
      snapshotDue = true;
      this.snapshotElapsedMs %= this.options.snapshotIntervalMs;
    }

    return {
      fixedSteps,
      clampedDeltaMs,
      droppedTimeMs,
      snapshotDue,
      simulationTimeMs: this.elapsedSimulationMs,
    };
  }
}
