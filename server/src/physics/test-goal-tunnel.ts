import assert from 'node:assert/strict';
import { getConstant } from '../../../shared/src/constants/index.js';
import { createArenaColliders } from './arena.js';
import { createBall } from './ball.js';
import { createWorld, initPhysics } from './world.js';

const TEST_SECONDS = 2.5;
// Allows Rapier's brief high-speed contact penetration while still rejecting escape/tunneling.
const PENETRATION_TOLERANCE = 0.25;

async function main(): Promise<void> {
  await initPhysics();
  const timestep = getConstant('PHYSICS.TIMESTEP');
  const frameCount = Math.round(TEST_SECONDS / timestep);
  const radius = getConstant('BALL.RADIUS');
  const goalWidth = getConstant('ARENA.GOAL.WIDTH');
  const goalHeight = getConstant('ARENA.GOAL.HEIGHT');
  const goalDepth = getConstant('ARENA.GOAL.DEPTH');
  const length = getConstant('ARENA.LENGTH');

  for (const zSign of [-1, 1]) {
    const world = createWorld();
    createArenaColliders(world);
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
      world.step();
      const position = ball.translation();
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
    world.free();
  }

  console.log('=== GOAL TUNNEL HARNESS: PASS ===');
}

main().catch((error: unknown) => {
  console.error('=== GOAL TUNNEL HARNESS: FAIL ===');
  console.error(error);
  process.exitCode = 1;
});
