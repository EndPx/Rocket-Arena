import assert from 'node:assert/strict';
import type RAPIER from '@dimforge/rapier3d-compat';
import { getConstant } from '../../../shared/src/constants/index.js';
import type { InputPayload } from '../../../shared/src/types/input.js';
import { createArenaColliders } from './arena.js';
import { createBall } from './ball.js';
import {
  applyCarPhysics,
  createCar,
  createCarPhysicsState,
  getCarMotion,
  resetCarPhysicsState,
} from './car.js';
import { createWorld, initPhysics } from './world.js';

const IMPACT_DETECTION_SPEED = 0.5;
const MAX_APPROACH_SECONDS = 5;
const POST_IMPACT_SECONDS = 0.75;
const SETTLE_SECONDS = 0.35;

interface ImpactResult {
  label: string;
  impactSeconds: number;
  approachSpeed: number;
  ballPeakSpeed: number;
  finalBallZ: number;
  minimumBallZAfterImpact: number;
  boostUsed: number;
}

function runImpact(
  label: string,
  startDistance: number,
  input: InputPayload,
): ImpactResult {
  const world = createWorld();
  createArenaColliders(world);
  const car = createCar(world, {
    x: 0,
    y: getConstant('CAR.BODY.HEIGHT') / 2
      + getConstant('ARENA.KICKOFF.SPAWN_CLEARANCE'),
    z: -startDistance,
  });
  const ball = createBall(world);
  const state = createCarPhysicsState();
  const timestep = getConstant('PHYSICS.TIMESTEP');

  for (let frame = 0; frame < Math.round(SETTLE_SECONDS / timestep); frame++) world.step();
  resetCarPhysicsState(state);
  const startingBoost = state.boostAmount;

  let impactFrame = -1;
  let approachSpeed = 0;
  let ballPeakSpeed = 0;
  let minimumBallZAfterImpact = Number.POSITIVE_INFINITY;
  const maxFrames = Math.round(MAX_APPROACH_SECONDS / timestep);
  const postImpactFrames = Math.round(POST_IMPACT_SECONDS / timestep);

  for (let frame = 0; frame < maxFrames; frame++) {
    const preStepSpeed = getCarMotion(car).horizontalSpeed;
    applyCarPhysics(world, car, input, state);
    world.step();

    const ballVelocity = ball.linvel();
    const ballSpeed = Math.hypot(ballVelocity.x, ballVelocity.z);
    if (impactFrame < 0 && ballSpeed >= IMPACT_DETECTION_SPEED) {
      impactFrame = frame;
      approachSpeed = preStepSpeed;
    }

    if (impactFrame >= 0) {
      ballPeakSpeed = Math.max(ballPeakSpeed, ballSpeed);
      minimumBallZAfterImpact = Math.min(minimumBallZAfterImpact, ball.translation().z);
      if (frame - impactFrame >= postImpactFrames) break;
    }
  }

  const finalBallZ = ball.translation().z;
  assert.ok(impactFrame >= 0, `${label}: car never contacted the ball`);
  assert.ok(Number.isFinite(ballPeakSpeed), `${label}: ball speed became non-finite`);
  assert.ok(ballPeakSpeed > IMPACT_DETECTION_SPEED, `${label}: impact failed to move the ball`);
  assert.ok(
    minimumBallZAfterImpact >= -getConstant('BALL.RADIUS') * 0.25,
    `${label}: ball tunneled backward through the car (${minimumBallZAfterImpact.toFixed(2)}m)`,
  );
  assert.ok(
    ballPeakSpeed < getConstant('CAR.BOOST.MAX_SPEED') * 1.8,
    `${label}: impact created an unstable speed spike (${ballPeakSpeed.toFixed(2)}m/s)`,
  );

  const result = {
    label,
    impactSeconds: impactFrame * timestep,
    approachSpeed,
    ballPeakSpeed,
    finalBallZ,
    minimumBallZAfterImpact,
    boostUsed: input.boost ? Math.max(0, startingBoost - state.boostAmount) : 0,
  };
  world.free();
  return result;
}

function printResult(result: ImpactResult): void {
  const ratio = result.ballPeakSpeed / result.approachSpeed;
  console.log(`${result.label}: impact=${result.impactSeconds.toFixed(2)}s car=${result.approachSpeed.toFixed(2)}m/s ball=${result.ballPeakSpeed.toFixed(2)}m/s ratio=${ratio.toFixed(2)}x finalZ=${result.finalBallZ.toFixed(2)}m boostUsed=${result.boostUsed.toFixed(1)}`);
}

async function main(): Promise<void> {
  await initPhysics();

  const low = runImpact(
    'low tap',
    6,
    { throttle: 0.35, steer: 0, jump: false, boost: false },
  );
  const normal = runImpact(
    'normal hit',
    20,
    { throttle: 1, steer: 0, jump: false, boost: false },
  );
  const boost = runImpact(
    'boost hit',
    20,
    { throttle: 1, steer: 0, jump: false, boost: true },
  );

  assert.ok(low.approachSpeed < normal.approachSpeed * 0.65, 'low tap approach must remain meaningfully slower');
  assert.ok(normal.approachSpeed > getConstant('CAR.ENGINE.MAX_SPEED') * 0.7, 'normal approach should reach useful match speed');
  assert.ok(boost.approachSpeed > normal.approachSpeed * 1.12, 'boost approach must be clearly faster than normal');
  assert.ok(low.ballPeakSpeed < normal.ballPeakSpeed * 0.7, 'slow taps must launch the ball gently');
  assert.ok(normal.ballPeakSpeed > low.ballPeakSpeed * 1.5, 'normal hits must feel punchier than taps');
  assert.ok(boost.ballPeakSpeed > normal.ballPeakSpeed * 1.1, 'boost hits must clearly exceed normal hits');

  console.log('=== IMPACT HARNESS: PASS ===');
  printResult(low);
  printResult(normal);
  printResult(boost);
}

main().catch((error: unknown) => {
  console.error('=== IMPACT HARNESS: FAIL ===');
  console.error(error);
  process.exitCode = 1;
});
