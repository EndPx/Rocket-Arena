import assert from 'node:assert/strict';
import RAPIER from '@dimforge/rapier3d-compat';
import {
  DEFAULT_TUNING_REGISTRY_SNAPSHOT,
  TUNING_IDS,
  getScalarTuningValue,
} from '@rocket-arena/shared';
import { getConstant } from '../../../shared/src/constants/index.js';
import type { InputPayload } from '../../../shared/src/types/input.js';
import { createArenaColliders } from './arena.js';
import {
  BALL_LINEAR_SPEED_TOLERANCE,
  createBall,
  recoverBallAfterStep,
  recoverBallBeforeStep,
} from './ball.js';
import {
  applyCarPhysics,
  createCar,
  createCarPhysicsState,
  getCarMotion,
  recoverCarBodyAfterStep,
  recoverCarBodyBeforeStep,
  resetCarPhysicsState,
} from './car.js';
import { createWorld, initPhysics } from './world.js';

const IMPACT_DETECTION_SPEED = 0.5;
const MAX_APPROACH_SECONDS = 5;
const POST_IMPACT_SECONDS = 0.75;
const SETTLE_SECONDS = 0.35;
const EPSILON = 1e-5;

interface ImpactResult {
  label: string;
  impactSeconds: number;
  approachSpeed: number;
  ballPeakSpeed: number;
  ballPeakAngularSpeed: number;
  finalBallZ: number;
  minimumBallZAfterImpact: number;
  boostUsed: number;
  scriptedAngularImpulseCalls: number;
}

interface DisposalTracker {
  created: number;
  freed: number;
}

const disposalTracker: DisposalTracker = { created: 0, freed: 0 };

function tuning(id: string): number {
  return getScalarTuningValue(DEFAULT_TUNING_REGISTRY_SNAPSHOT, id);
}

function createTrackedWorld(): RAPIER.World {
  const world = createWorld();
  disposalTracker.created += 1;
  return world;
}

function freeTrackedWorld(world: RAPIER.World): void {
  world.free();
  disposalTracker.freed += 1;
}

function instrumentScriptedAngularImpulse(ball: RAPIER.RigidBody): () => number {
  let calls = 0;
  const original = ball.applyTorqueImpulse.bind(ball);
  ball.applyTorqueImpulse = (
    ...args: Parameters<RAPIER.RigidBody['applyTorqueImpulse']>
  ): void => {
    calls += 1;
    original(...args);
  };
  return () => calls;
}

function runImpact(
  label: string,
  startDistance: number,
  input: InputPayload,
  ballX: number = 0,
): ImpactResult {
  const world = createTrackedWorld();
  try {
    createArenaColliders(world);
    const car = createCar(world, {
      x: 0,
      y: tuning(TUNING_IDS.car.collider.height) / 2
        + getConstant('ARENA.KICKOFF.SPAWN_CLEARANCE'),
      z: -startDistance,
    });
    const ball = createBall(world, {
      x: ballX,
      y: tuning(TUNING_IDS.ball.radius) + getConstant('BALL.SPAWN_CLEARANCE'),
      z: 0,
    });
    const scriptedAngularImpulseCalls = instrumentScriptedAngularImpulse(ball);
    const state = createCarPhysicsState();
    const timestep = tuning(TUNING_IDS.physics.fixedStepSeconds);
    const maximumBallSpeed = tuning(TUNING_IDS.ball.maxLinearSpeed)
      + BALL_LINEAR_SPEED_TOLERANCE;
    const maximumBallAngularSpeed = tuning(TUNING_IDS.ball.maxAngularSpeed);

    assert.equal(car.mass(), 150, `${label}: car mass must be exactly 150 kg`);
    assert.equal(ball.mass(), 25, `${label}: ball mass must be exactly 25 kg`);
    assert.equal(car.mass() / ball.mass(), 6, `${label}: car:ball mass ratio must be 6:1`);
    assert.equal(car.isCcdEnabled(), true, `${label}: car CCD must be enabled`);
    assert.equal(ball.isCcdEnabled(), true, `${label}: ball CCD must be enabled`);

    for (let frame = 0; frame < Math.round(SETTLE_SECONDS / timestep); frame++) {
      recoverCarBodyBeforeStep(car);
      recoverBallBeforeStep(ball);
      world.step();
      recoverCarBodyAfterStep(car);
      recoverBallAfterStep(ball);
    }
    resetCarPhysicsState(state);
    const startingBoost = state.boostAmount;

    let impactFrame = -1;
    let approachSpeed = 0;
    let ballPeakSpeed = 0;
    let ballPeakAngularSpeed = 0;
    let minimumBallZAfterImpact = Number.POSITIVE_INFINITY;
    const maxFrames = Math.round(MAX_APPROACH_SECONDS / timestep);
    const postImpactFrames = Math.round(POST_IMPACT_SECONDS / timestep);

    for (let frame = 0; frame < maxFrames; frame++) {
      recoverCarBodyBeforeStep(car);
      recoverBallBeforeStep(ball);
      const preStepSpeed = getCarMotion(car).horizontalSpeed;
      applyCarPhysics(world, car, input, state);
      world.step();
      recoverCarBodyAfterStep(car);
      const boundedBall = recoverBallAfterStep(ball);

      const ballVelocity = boundedBall.linearVelocity;
      const ballAngularVelocity = boundedBall.angularVelocity;
      const ballSpeed = Math.hypot(ballVelocity.x, ballVelocity.y, ballVelocity.z);
      const horizontalBallSpeed = Math.hypot(ballVelocity.x, ballVelocity.z);
      const ballAngularSpeed = Math.hypot(
        ballAngularVelocity.x,
        ballAngularVelocity.y,
        ballAngularVelocity.z,
      );
      assert.ok(
        ballSpeed <= maximumBallSpeed + EPSILON,
        `${label}: ball exceeded the 60.05 m/s post-step bound`,
      );
      assert.ok(
        ballAngularSpeed <= maximumBallAngularSpeed + EPSILON,
        `${label}: ball exceeded the 6 rad/s post-step angular bound`,
      );

      if (impactFrame < 0 && horizontalBallSpeed >= IMPACT_DETECTION_SPEED) {
        impactFrame = frame;
        approachSpeed = preStepSpeed;
      }

      if (impactFrame >= 0) {
        ballPeakSpeed = Math.max(ballPeakSpeed, ballSpeed);
        ballPeakAngularSpeed = Math.max(ballPeakAngularSpeed, ballAngularSpeed);
        minimumBallZAfterImpact = Math.min(minimumBallZAfterImpact, ball.translation().z);
        if (frame - impactFrame >= postImpactFrames) break;
      }
    }

    const finalBallZ = ball.translation().z;
    assert.ok(impactFrame >= 0, `${label}: car never contacted the ball`);
    assert.ok(Number.isFinite(ballPeakSpeed), `${label}: ball speed became non-finite`);
    assert.ok(Number.isFinite(ballPeakAngularSpeed), `${label}: ball spin became non-finite`);
    assert.ok(ballPeakSpeed > IMPACT_DETECTION_SPEED, `${label}: impact failed to move the ball`);
    assert.ok(
      minimumBallZAfterImpact >= -tuning(TUNING_IDS.ball.radius) * 0.25,
      `${label}: ball tunneled backward through the car (${minimumBallZAfterImpact.toFixed(2)}m)`,
    );
    assert.ok(
      ballPeakSpeed <= maximumBallSpeed + EPSILON,
      `${label}: impact created an unstable speed spike (${ballPeakSpeed.toFixed(2)}m/s)`,
    );
    assert.equal(
      scriptedAngularImpulseCalls(),
      0,
      `${label}: Ball_System must apply zero scripted angular impulses`,
    );

    return {
      label,
      impactSeconds: impactFrame * timestep,
      approachSpeed,
      ballPeakSpeed,
      ballPeakAngularSpeed,
      finalBallZ,
      minimumBallZAfterImpact,
      boostUsed: input.boost ? Math.max(0, startingBoost - state.boostAmount) : 0,
      scriptedAngularImpulseCalls: scriptedAngularImpulseCalls(),
    };
  } finally {
    freeTrackedWorld(world);
  }
}

function printResult(result: ImpactResult): void {
  const ratio = result.ballPeakSpeed / result.approachSpeed;
  console.log(`${result.label}: impact=${result.impactSeconds.toFixed(2)}s car=${result.approachSpeed.toFixed(2)}m/s ball=${result.ballPeakSpeed.toFixed(2)}m/s ratio=${ratio.toFixed(2)}x spin=${result.ballPeakAngularSpeed.toFixed(2)}rad/s finalZ=${result.finalBallZ.toFixed(2)}m boostUsed=${result.boostUsed.toFixed(1)} scriptedTorque=${result.scriptedAngularImpulseCalls}`);
}

function assertSetupFailureCleanup(): void {
  assert.throws(() => {
    const world = createTrackedWorld();
    try {
      createCar(world, { x: 0, y: 1, z: -2 });
      createBall(world);
      throw new Error('synthetic impact setup assertion failure');
    } finally {
      freeTrackedWorld(world);
    }
  }, /synthetic impact setup assertion failure/);
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
  const offCenter = runImpact(
    'off-center contact',
    16,
    { throttle: 1, steer: 0, jump: false, boost: false },
    0.55,
  );

  assert.ok(low.approachSpeed < normal.approachSpeed * 0.65, 'low tap approach must remain meaningfully slower');
  assert.ok(normal.approachSpeed > tuning(TUNING_IDS.car.maxLinearSpeed) * 0.7, 'normal approach should reach useful match speed');
  assert.ok(boost.approachSpeed >= normal.approachSpeed * 0.98, 'boost approach must not regress normal approach speed at the shared cap');
  assert.ok(low.ballPeakSpeed < normal.ballPeakSpeed * 0.7, 'slow taps must launch the ball gently');
  assert.ok(normal.ballPeakSpeed > low.ballPeakSpeed * 1.5, 'normal hits must feel punchier than taps');
  assert.ok(
    offCenter.ballPeakAngularSpeed > 0.05,
    `off-center Rapier contact must produce ball spin, received ${offCenter.ballPeakAngularSpeed.toFixed(3)}rad/s`,
  );
  assert.equal(offCenter.scriptedAngularImpulseCalls, 0, 'off-center spin must be collision-owned');
  assertSetupFailureCleanup();
  assert.equal(
    disposalTracker.freed,
    disposalTracker.created,
    'every impact-harness Rapier world must be freed',
  );

  console.log('=== IMPACT HARNESS: PASS ===');
  printResult(low);
  printResult(normal);
  printResult(boost);
  printResult(offCenter);
  console.log(`cleanup=${disposalTracker.freed}/${disposalTracker.created} worlds`);
}

main().catch((error: unknown) => {
  console.error('=== IMPACT HARNESS: FAIL ===');
  console.error(error);
  process.exitCode = 1;
});
