import assert from 'node:assert/strict';
import type RAPIER from '@dimforge/rapier3d-compat';
import {
  DEFAULT_TUNING_REGISTRY_SNAPSHOT,
  TUNING_IDS,
  getScalarTuningValue,
} from '@rocket-arena/shared';
import { getConstant } from '../../../shared/src/constants/index.js';
import { createArenaColliders } from './arena.js';
import {
  createBall,
  recoverBallAfterStep,
  recoverBallBeforeStep,
} from './ball.js';
import { createWorld, initPhysics } from './world.js';

const TEST_SECONDS = 2.5;
// Allows Rapier's brief high-speed contact penetration while still rejecting escape/tunneling.
const PENETRATION_TOLERANCE = 0.25;

function tuning(id: string): number {
  return getScalarTuningValue(DEFAULT_TUNING_REGISTRY_SNAPSHOT, id);
}

function runGoalInterior(zSign: number): void {
  let world: RAPIER.World | null = null;
  try {
    world = createWorld();
    createArenaColliders(world);
    const timestep = tuning(TUNING_IDS.physics.fixedStepSeconds);
    const frameCount = Math.round(TEST_SECONDS / timestep);
    const radius = tuning(TUNING_IDS.ball.radius);
    const goalWidth = getConstant('ARENA.GOAL.WIDTH');
    const goalHeight = getConstant('ARENA.GOAL.HEIGHT');
    const goalDepth = getConstant('ARENA.GOAL.DEPTH');
    const length = getConstant('ARENA.LENGTH');
    const ball = createBall(world, {
      x: 0,
      y: radius + getConstant('BALL.SPAWN_CLEARANCE'),
      z: zSign * (length / 2 + goalDepth / 2),
    });
    ball.setLinvel({ x: 18, y: 14, z: 0 }, true);

    let maxAbsX = 0;
    let minimumY = Number.POSITIVE_INFINITY;
    let maximumY = Number.NEGATIVE_INFINITY;
    for (let frame = 0; frame < frameCount; frame++) {
      recoverBallBeforeStep(ball);
      world.step();
      const state = recoverBallAfterStep(ball);
      const position = state.translation;
      maxAbsX = Math.max(maxAbsX, Math.abs(position.x));
      minimumY = Math.min(minimumY, position.y);
      maximumY = Math.max(maximumY, position.y);
      assert.ok(Number.isFinite(position.x) && Number.isFinite(position.y) && Number.isFinite(position.z));
    }

    assert.ok(
      maxAbsX <= goalWidth / 2 - radius + PENETRATION_TOLERANCE,
      `goal side containment failed at sign ${zSign}: |x|=${maxAbsX.toFixed(3)}`,
    );
    assert.ok(
      minimumY >= radius - PENETRATION_TOLERANCE,
      `goal floor containment failed at sign ${zSign}: y=${minimumY.toFixed(3)}`,
    );
    assert.ok(
      maximumY <= goalHeight - radius + PENETRATION_TOLERANCE,
      `goal roof containment failed at sign ${zSign}: y=${maximumY.toFixed(3)}`,
    );
  } finally {
    world?.free();
  }
}

async function main(): Promise<void> {
  await initPhysics();
  for (const zSign of [-1, 1]) runGoalInterior(zSign);
  console.log('=== GOAL TUNNEL HARNESS: PASS ===');
}

main().catch((error: unknown) => {
  console.error('=== GOAL TUNNEL HARNESS: FAIL ===');
  console.error(error);
  process.exitCode = 1;
});
