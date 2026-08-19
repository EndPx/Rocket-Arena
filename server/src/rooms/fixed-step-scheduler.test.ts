import assert from 'node:assert/strict';
import test from 'node:test';
import { PHYSICS, NETCODE } from '@rocket-arena/shared';
import {
  FixedStepScheduler,
  type FixedStepSchedulerOptions,
} from './fixed-step-scheduler.js';

function createScheduler(
  overrides: Partial<FixedStepSchedulerOptions> = {},
): FixedStepScheduler {
  return new FixedStepScheduler({
    fixedStepSeconds: PHYSICS.TIMESTEP,
    maxFrameDeltaSeconds: PHYSICS.MAX_FRAME_DELTA_SECONDS,
    maxSubsteps: PHYSICS.MAX_FIXED_SUBSTEPS,
    snapshotIntervalMs: NETCODE.SNAPSHOT_TARGET_INTERVAL_MS,
    snapshotSchedulingToleranceMs: NETCODE.SNAPSHOT_SCHEDULING_TOLERANCE_MS,
    ...overrides,
  });
}

// **Validates: Requirements 1.4, 1.8**
test('one second of callbacks preserves exact 60 Hz steps and independent snapshots', () => {
  const scheduler = createScheduler();
  let steps = 0;
  let snapshots = 0;
  for (let frame = 0; frame < 60; frame++) {
    const result = scheduler.advance(1000 / 60);
    steps += result.fixedSteps;
    snapshots += Number(result.snapshotDue);
  }

  assert.equal(PHYSICS.TIMESTEP, 1 / 60);
  assert.equal(steps, 60);
  assert.ok(Math.abs(scheduler.simulationTimeMs - 1000) < 1e-9);
  assert.ok(snapshots >= 29 && snapshots <= 31, `snapshot count was ${snapshots}`);
  assert.notEqual(
    NETCODE.SNAPSHOT_TARGET_INTERVAL_MS,
    PHYSICS.TIMESTEP * 1000,
  );
});

// **Validates: Requirements 1.6, 1.7**
test('a long callback is clamped, capped at five steps, and retains a bounded remainder', () => {
  const scheduler = createScheduler();
  const result = scheduler.advance(1000);

  assert.equal(PHYSICS.MAX_FRAME_DELTA_SECONDS, 0.1);
  assert.equal(PHYSICS.MAX_FIXED_SUBSTEPS, 5);
  assert.equal(result.clampedDeltaMs, PHYSICS.MAX_FRAME_DELTA_SECONDS * 1000);
  assert.equal(result.fixedSteps, PHYSICS.MAX_FIXED_SUBSTEPS);
  assert.ok(result.droppedTimeMs > 0);
  assert.ok(result.accumulatorRemainderSeconds >= 0);
  assert.ok(result.accumulatorRemainderSeconds < PHYSICS.TIMESTEP);
  assert.equal(result.accumulatorRemainderSeconds, scheduler.accumulatorRemainderSeconds);
  assert.ok(
    Math.abs(result.accumulatorRemainderMs - result.accumulatorRemainderSeconds * 1000)
      < 1e-12,
  );
  assert.equal(
    result.simulationTimeMs,
    PHYSICS.MAX_FIXED_SUBSTEPS * PHYSICS.TIMESTEP * 1000,
  );

  const earliestDueMs = NETCODE.SNAPSHOT_TARGET_INTERVAL_MS
    - NETCODE.SNAPSHOT_SCHEDULING_TOLERANCE_MS;
  assert.equal(scheduler.advance(earliestDueMs - 0.01).snapshotDue, false);
  assert.equal(scheduler.advance(0.02).snapshotDue, true);
});

// **Validates: Requirements 1.5**
test('negative and non-finite callback deltas contribute zero elapsed time', () => {
  const scheduler = createScheduler();
  scheduler.advance(0); // Consume the intentionally immediate initial snapshot.

  for (const delta of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const beforeRemainder = scheduler.accumulatorRemainderSeconds;
    const result = scheduler.advance(delta);
    assert.equal(result.clampedDeltaMs, 0);
    assert.equal(result.fixedSteps, 0);
    assert.equal(result.droppedTimeMs, 0);
    assert.equal(result.simulationTimeMs, 0);
    assert.equal(result.accumulatorRemainderSeconds, beforeRemainder);
    assert.equal(result.snapshotDue, false);
  }
});

// **Validates: Requirements 1.8, 6.8**
test('snapshot decisions become due within the finite admissible tolerance', () => {
  const scheduler = createScheduler();
  const initial = scheduler.advance(0);
  assert.equal(initial.snapshotDecision.reason, 'initial');
  assert.equal(initial.snapshotDue, true);

  const earliestDueMs = NETCODE.SNAPSHOT_TARGET_INTERVAL_MS
    - NETCODE.SNAPSHOT_SCHEDULING_TOLERANCE_MS;
  const pending = scheduler.advance(earliestDueMs - 0.01);
  assert.equal(pending.snapshotDue, false);
  assert.deepEqual(pending.snapshotDecision, {
    due: false,
    reason: 'pending',
    elapsedMs: earliestDueMs - 0.01,
    targetIntervalMs: NETCODE.SNAPSHOT_TARGET_INTERVAL_MS,
    toleranceMs: NETCODE.SNAPSHOT_SCHEDULING_TOLERANCE_MS,
    earliestDueMs,
  });

  const admissible = scheduler.advance(0.02);
  assert.equal(admissible.snapshotDue, true);
  assert.equal(admissible.snapshotDecision.reason, 'interval');
  assert.ok(admissible.snapshotDecision.elapsedMs >= earliestDueMs);
  assert.ok(admissible.snapshotDecision.elapsedMs < NETCODE.SNAPSHOT_TARGET_INTERVAL_MS);

  const strictScheduler = createScheduler({ snapshotSchedulingToleranceMs: 0 });
  strictScheduler.advance(0);
  assert.equal(strictScheduler.advance(earliestDueMs + 0.01).snapshotDue, false);
  assert.equal(
    strictScheduler.advance(NETCODE.SNAPSHOT_SCHEDULING_TOLERANCE_MS).snapshotDue,
    true,
  );
});

test('snapshot scheduling tolerance rejects negative and non-finite configuration', () => {
  for (const tolerance of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => createScheduler({ snapshotSchedulingToleranceMs: tolerance }),
      /snapshotSchedulingToleranceMs must be finite and non-negative/,
    );
  }
});

// **Validates: Requirements 1.5-1.7**
test('generated jitter schedules preserve accounting, bounded work, and remainder', () => {
  const scheduler = createScheduler();
  let state = 0x5eed1234;
  let previousSimulationTime = 0;

  for (let frame = 0; frame < 512; frame++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const jitteredDelta = 4 + (state % 180);
    const result = scheduler.advance(jitteredDelta);

    assert.ok(result.fixedSteps >= 0 && result.fixedSteps <= PHYSICS.MAX_FIXED_SUBSTEPS);
    assert.ok(result.clampedDeltaMs <= PHYSICS.MAX_FRAME_DELTA_SECONDS * 1000);
    assert.ok(result.accumulatorRemainderSeconds >= 0);
    assert.ok(result.accumulatorRemainderSeconds < PHYSICS.TIMESTEP);
    assert.ok(
      Math.abs(
        result.simulationTimeMs
          - previousSimulationTime
          - result.fixedSteps * PHYSICS.TIMESTEP * 1000,
      ) < 1e-9,
    );
    previousSimulationTime = result.simulationTimeMs;
  }
});
