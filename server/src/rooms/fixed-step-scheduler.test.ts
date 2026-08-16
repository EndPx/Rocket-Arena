import assert from 'node:assert/strict';
import test from 'node:test';
import { PHYSICS, NETCODE } from '@rocket-arena/shared';
import { FixedStepScheduler } from './fixed-step-scheduler.js';

function createScheduler(): FixedStepScheduler {
  return new FixedStepScheduler({
    fixedStepSeconds: PHYSICS.TIMESTEP,
    maxFrameDeltaSeconds: PHYSICS.MAX_FRAME_DELTA_SECONDS,
    maxSubsteps: PHYSICS.MAX_FIXED_SUBSTEPS,
    snapshotIntervalMs: NETCODE.PATCH_RATE_MS,
  });
}

test('one second of callbacks produces exactly sixty fixed steps', () => {
  const scheduler = createScheduler();
  let steps = 0;
  let snapshots = 0;
  for (let frame = 0; frame < 60; frame++) {
    const result = scheduler.advance(1000 / 60);
    steps += result.fixedSteps;
    snapshots += Number(result.snapshotDue);
  }

  assert.equal(steps, 60);
  assert.ok(Math.abs(scheduler.simulationTimeMs - 1000) < 1e-9);
  assert.ok(snapshots >= 29 && snapshots <= 31, `snapshot count was ${snapshots}`);
});

test('a long callback is clamped and bounded without variable physics dt', () => {
  const scheduler = createScheduler();
  const result = scheduler.advance(1000);

  assert.equal(result.clampedDeltaMs, PHYSICS.MAX_FRAME_DELTA_SECONDS * 1000);
  assert.equal(result.fixedSteps, PHYSICS.MAX_FIXED_SUBSTEPS);
  assert.ok(result.droppedTimeMs > 0);
  assert.equal(
    result.simulationTimeMs,
    PHYSICS.MAX_FIXED_SUBSTEPS * PHYSICS.TIMESTEP * 1000,
  );
});

// **Validates: Requirements 2, 5**
test('generated jitter schedules preserve fixed-step accounting and bounded work', () => {
  const scheduler = createScheduler();
  let state = 0x5eed1234;
  let previousSimulationTime = 0;

  for (let frame = 0; frame < 512; frame++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const jitteredDelta = 4 + (state % 180);
    const result = scheduler.advance(jitteredDelta);

    assert.ok(result.fixedSteps >= 0 && result.fixedSteps <= PHYSICS.MAX_FIXED_SUBSTEPS);
    assert.ok(result.clampedDeltaMs <= PHYSICS.MAX_FRAME_DELTA_SECONDS * 1000);
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
