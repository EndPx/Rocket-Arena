import assert from 'node:assert/strict';
import { getConstant } from '../../../shared/src/constants/index.js';
import { createArenaColliders } from './arena.js';
import { createBall } from './ball.js';
import { createWorld, initPhysics } from './world.js';

const DROP_HEIGHT = 10;
const TEST_SECONDS = 6;
const REST_HEIGHT_TOLERANCE = 0.08;
const MAX_TRANSIENT_PENETRATION = 0.15;
const REST_SPEED_TOLERANCE = 0.08;
const REQUIRED_SETTLED_SECONDS = 0.35;

function assertFinite(label: string, value: number): void {
  assert.ok(Number.isFinite(value), `${label} must remain finite, received ${value}`);
}

async function main(): Promise<void> {
  await initPhysics();
  const world = createWorld();
  createArenaColliders(world);
  const ball = createBall(world, { x: 0, y: DROP_HEIGHT, z: 0 });

  const timestep = getConstant('PHYSICS.TIMESTEP');
  const frameCount = Math.round(TEST_SECONDS / timestep);
  const requiredSettledFrames = Math.round(REQUIRED_SETTLED_SECONDS / timestep);
  const restHeight = getConstant('BALL.RADIUS')
    + getConstant('BALL.CONTACT_SKIN')
    + getConstant('ARENA.SURFACE.CONTACT_SKIN');

  let previousVy = ball.linvel().y;
  let impactFrame = -1;
  let reboundApex = 0;
  let settledFrame = -1;
  let consecutiveSettledFrames = 0;
  let maximumSpeed = 0;
  let minimumY = Number.POSITIVE_INFINITY;

  for (let frame = 0; frame < frameCount; frame++) {
    world.step();
    const position = ball.translation();
    const velocity = ball.linvel();
    const speed = Math.hypot(velocity.x, velocity.y, velocity.z);

    assertFinite('ball y', position.y);
    assertFinite('ball speed', speed);
    maximumSpeed = Math.max(maximumSpeed, speed);
    minimumY = Math.min(minimumY, position.y);

    if (impactFrame < 0 && previousVy < 0 && velocity.y > 0) {
      impactFrame = frame;
    }
    if (impactFrame >= 0) reboundApex = Math.max(reboundApex, position.y);

    const resting = Math.abs(position.y - restHeight) <= REST_HEIGHT_TOLERANCE
      && Math.abs(velocity.y) <= REST_SPEED_TOLERANCE;
    consecutiveSettledFrames = resting ? consecutiveSettledFrames + 1 : 0;
    if (settledFrame < 0 && consecutiveSettledFrames >= requiredSettledFrames) {
      settledFrame = frame - requiredSettledFrames + 1;
    }

    previousVy = velocity.y;
  }

  const finalPosition = ball.translation();
  const finalVelocity = ball.linvel();

  assert.ok(impactFrame >= 0, 'ball must contact and rebound from the floor');
  assert.ok(
    reboundApex > restHeight + getConstant('BALL.RADIUS') * 0.5,
    `first rebound must be visible, apex=${reboundApex.toFixed(3)}m`,
  );
  assert.ok(reboundApex < DROP_HEIGHT, 'rebound must not create energy');
  assert.ok(
    minimumY >= getConstant('BALL.RADIUS') - MAX_TRANSIENT_PENETRATION,
    `ball penetrated the floor: minimum y=${minimumY.toFixed(3)}m`,
  );
  assert.ok(settledFrame >= 0, 'ball must settle within the deterministic test window');
  assert.ok(
    Math.abs(finalPosition.y - restHeight) <= REST_HEIGHT_TOLERANCE,
    `rest height ${finalPosition.y.toFixed(3)}m differs from expected ${restHeight.toFixed(3)}m`,
  );
  assert.ok(Math.abs(finalVelocity.y) <= REST_SPEED_TOLERANCE, 'settled ball must have negligible vertical speed');

  console.log('=== BALL HARNESS: PASS ===');
  console.log(`drop=${DROP_HEIGHT.toFixed(2)}m impact=${(impactFrame * timestep).toFixed(2)}s reboundApex=${reboundApex.toFixed(2)}m`);
  console.log(`settled=${(settledFrame * timestep).toFixed(2)}s restY=${finalPosition.y.toFixed(3)}m maxSpeed=${maximumSpeed.toFixed(2)}m/s`);

  world.free();
}

main().catch((error: unknown) => {
  console.error('=== BALL HARNESS: FAIL ===');
  console.error(error);
  process.exitCode = 1;
});
