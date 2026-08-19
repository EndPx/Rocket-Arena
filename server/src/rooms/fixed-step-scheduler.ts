export interface FixedStepSchedulerOptions {
  readonly fixedStepSeconds: number;
  readonly maxFrameDeltaSeconds: number;
  readonly maxSubsteps: number;
  readonly snapshotIntervalMs: number;
  readonly snapshotSchedulingToleranceMs?: number;
}

export type SnapshotScheduleReason = 'initial' | 'interval' | 'pending';

/** Observable wall-clock inputs and result for one snapshot scheduling decision. */
export interface SnapshotScheduleDecision {
  readonly due: boolean;
  readonly reason: SnapshotScheduleReason;
  readonly elapsedMs: number;
  readonly targetIntervalMs: number;
  readonly toleranceMs: number;
  readonly earliestDueMs: number;
}

export interface FixedStepFrame {
  readonly fixedSteps: number;
  readonly clampedDeltaMs: number;
  readonly droppedTimeMs: number;
  readonly accumulatorRemainderSeconds: number;
  readonly accumulatorRemainderMs: number;
  readonly snapshotDue: boolean;
  readonly snapshotDecision: SnapshotScheduleDecision;
  readonly simulationTimeMs: number;
}

type NormalizedFixedStepSchedulerOptions = Required<FixedStepSchedulerOptions>;

function requirePositiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be positive and finite`);
  }
}

function requireNonNegativeFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be finite and non-negative`);
  }
}

/**
 * Converts jittery callback elapsed time into bounded, exact fixed substeps and
 * an independent, tolerance-aware snapshot cadence. Raw frame delta never
 * reaches simulation.
 */
export class FixedStepScheduler {
  private readonly options: Readonly<NormalizedFixedStepSchedulerOptions>;
  private accumulatorSeconds = 0;
  private snapshotElapsedMs = 0;
  private firstSnapshotPending = true;
  private elapsedSimulationMs = 0;

  constructor(options: FixedStepSchedulerOptions) {
    requirePositiveFinite(options.fixedStepSeconds, 'fixedStepSeconds');
    requirePositiveFinite(options.maxFrameDeltaSeconds, 'maxFrameDeltaSeconds');
    if (!Number.isFinite(options.maxSubsteps) || options.maxSubsteps < 1) {
      throw new Error('maxSubsteps must be finite and at least one');
    }
    requirePositiveFinite(options.snapshotIntervalMs, 'snapshotIntervalMs');

    const snapshotSchedulingToleranceMs = options.snapshotSchedulingToleranceMs ?? 0;
    requireNonNegativeFinite(
      snapshotSchedulingToleranceMs,
      'snapshotSchedulingToleranceMs',
    );

    this.options = Object.freeze({
      fixedStepSeconds: options.fixedStepSeconds,
      maxFrameDeltaSeconds: options.maxFrameDeltaSeconds,
      maxSubsteps: Math.floor(options.maxSubsteps),
      snapshotIntervalMs: options.snapshotIntervalMs,
      snapshotSchedulingToleranceMs,
    });
  }

  get simulationTimeMs(): number {
    return this.elapsedSimulationMs;
  }

  /** The retained fixed-step accumulator remainder, always in [0, fixedStep). */
  get accumulatorRemainderSeconds(): number {
    return this.accumulatorSeconds;
  }

  advance(rawDeltaMs: number): FixedStepFrame {
    const safeDeltaMs = Number.isFinite(rawDeltaMs) && rawDeltaMs >= 0
      ? rawDeltaMs
      : 0;
    const clampedDeltaMs = Math.min(
      safeDeltaMs,
      this.options.maxFrameDeltaSeconds * 1000,
    );
    const accumulatedSeconds = this.accumulatorSeconds + clampedDeltaMs / 1000;

    const epsilon = this.options.fixedStepSeconds * 1e-9;
    const availableSteps = Math.floor(
      (accumulatedSeconds + epsilon) / this.options.fixedStepSeconds,
    );
    const fixedSteps = Math.min(availableSteps, this.options.maxSubsteps);
    const droppedSteps = Math.max(0, availableSteps - fixedSteps);

    let remainderSeconds = accumulatedSeconds
      - (fixedSteps + droppedSteps) * this.options.fixedStepSeconds;
    if (remainderSeconds < 0 && remainderSeconds >= -epsilon) {
      remainderSeconds = 0;
    } else if (
      remainderSeconds < 0
      || remainderSeconds >= this.options.fixedStepSeconds
    ) {
      remainderSeconds = (
        (remainderSeconds % this.options.fixedStepSeconds)
        + this.options.fixedStepSeconds
      ) % this.options.fixedStepSeconds;
    }
    this.accumulatorSeconds = remainderSeconds;

    const droppedTimeMs = droppedSteps * this.options.fixedStepSeconds * 1000;
    this.elapsedSimulationMs += fixedSteps * this.options.fixedStepSeconds * 1000;
    const snapshotDecision = this.decideSnapshot(clampedDeltaMs);

    return {
      fixedSteps,
      clampedDeltaMs,
      droppedTimeMs,
      accumulatorRemainderSeconds: this.accumulatorSeconds,
      accumulatorRemainderMs: this.accumulatorSeconds * 1000,
      snapshotDue: snapshotDecision.due,
      snapshotDecision,
      simulationTimeMs: this.elapsedSimulationMs,
    };
  }

  private decideSnapshot(clampedDeltaMs: number): SnapshotScheduleDecision {
    this.snapshotElapsedMs += clampedDeltaMs;
    const elapsedMs = this.snapshotElapsedMs;
    const targetIntervalMs = this.options.snapshotIntervalMs;
    const toleranceMs = this.options.snapshotSchedulingToleranceMs;
    const earliestDueMs = Math.max(0, targetIntervalMs - toleranceMs);

    let due = false;
    let reason: SnapshotScheduleReason = 'pending';
    if (this.firstSnapshotPending) {
      due = true;
      reason = 'initial';
      this.firstSnapshotPending = false;
    } else if (elapsedMs >= earliestDueMs) {
      due = true;
      reason = 'interval';
    }

    if (due) {
      this.snapshotElapsedMs = reason === 'initial'
        ? 0
        : elapsedMs >= targetIntervalMs
          ? elapsedMs % targetIntervalMs
          : 0;
    }

    return Object.freeze({
      due,
      reason,
      elapsedMs,
      targetIntervalMs,
      toleranceMs,
      earliestDueMs,
    });
  }
}
