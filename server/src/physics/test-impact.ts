import { initPhysics, createWorld } from './world.js';
import { createArenaColliders } from './arena.js';
import { createBall } from './ball.js';
import { createCar, applyCarPhysics } from './car.js';
import { getConstant } from '../../../shared/src/constants/index.js';
import type { InputPayload } from '../../../shared/src/types/input.js';

async function runImpactTest(label: string, input: InputPayload, approachFrames: number, startDistance: number = 15) {
  await initPhysics();
  const world = createWorld();
  createArenaColliders(world);

  const carHeight = getConstant('CAR.BODY.HEIGHT');
  const ballRadius = getConstant('BALL.RADIUS');

  // Car starts at specified distance behind ball
  const car = createCar(world, { x: 0, y: carHeight / 2 + 0.1, z: -startDistance });
  const ball = createBall(world, { x: 0, y: ballRadius + 0.1, z: 0 });
  const jumpState = { count: 0 };

  // Let physics settle for 10 frames before applying input
  for (let i = 0; i < 10; i++) {
    world.step();
  }

  let carSpeedAtImpact = 0;
  let ballSpeedAfterImpact = 0;
  let impactFrame = -1;

  for (let i = 0; i < approachFrames + 60; i++) {
    applyCarPhysics(world, car, input, jumpState);
    world.step();

    const ballVel = ball.linvel();
    const ballSpeed = Math.sqrt(ballVel.x * ballVel.x + ballVel.y * ballVel.y + ballVel.z * ballVel.z);

    // Detect impact: ball starts moving with significant horizontal velocity
    // Use Z velocity to detect car-ball contact (car drives along Z axis)
    if (Math.abs(ballVel.z) > 1.0 && impactFrame === -1) {
      impactFrame = i;
      const carVel = car.linvel();
      carSpeedAtImpact = Math.sqrt(carVel.x * carVel.x + carVel.z * carVel.z);
      ballSpeedAfterImpact = ballSpeed;
    }

    // Record max ball speed after impact
    if (impactFrame !== -1 && ballSpeed > ballSpeedAfterImpact) {
      ballSpeedAfterImpact = ballSpeed;
    }
  }

  const ballPos = ball.translation();
  const tunneled = ballPos.z < -1; // Ball went backward through car = tunnel

  console.log(`  ${label}:`);
  console.log(`    Impact at frame: ${impactFrame}`);
  console.log(`    Car speed at impact: ${carSpeedAtImpact.toFixed(2)} m/s`);
  console.log(`    Ball peak speed after impact: ${ballSpeedAfterImpact.toFixed(2)} m/s`);
  console.log(`    Ball final Z position: ${ballPos.z.toFixed(2)}m`);
  console.log(`    Tunneling: ${tunneled ? 'YES — BUG!' : 'No (CCD working)'}`);
  console.log(`    Speed ratio (ball/car): ${(ballSpeedAfterImpact / carSpeedAtImpact).toFixed(2)}x`);
  console.log('');
}

async function main() {
  console.log('=== Car-Ball Impact Test ===');
  console.log(`Car mass: ${getConstant('CAR.BODY.MASS')}kg, Ball mass: ${getConstant('BALL.MASS')}kg (ratio ${(getConstant('CAR.BODY.MASS') / getConstant('BALL.MASS')).toFixed(1)}:1)`);
  console.log(`Ball restitution: ${getConstant('BALL.RESTITUTION')}`);
  console.log('');

  // Low speed approach (close start — car hits ball before reaching high speed)
  await runImpactTest(
    'LOW SPEED (short approach)',
    { throttle: 1, steer: 0, jump: false, boost: false },
    60,
    5  // Only 5m away — car hits ball at low speed
  );

  // Max speed approach (long drive to build up speed)
  await runImpactTest(
    'MAX SPEED (full throttle)',
    { throttle: 1, steer: 0, jump: false, boost: false },
    180,
    20  // 20m approach for full speed buildup
  );

  // Boost speed approach
  await runImpactTest(
    'BOOST SPEED (throttle + boost)',
    { throttle: 1, steer: 0, jump: false, boost: true },
    120,
    15  // 15m with boost — reaches high speed quickly
  );

  console.log('=== Impact Test Complete ===');
}

main().catch(console.error);
