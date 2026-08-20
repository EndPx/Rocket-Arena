import assert from 'node:assert/strict';
import RAPIER from '@dimforge/rapier3d-compat';
import {
  ARENA_COLLISION_GEOMETRY,
  DEFAULT_TUNING_REGISTRY_SNAPSHOT,
  TUNING_IDS,
  getScalarTuningValue,
} from '@rocket-arena/shared';
import { getConstant } from '../../../shared/src/constants/index.js';
import type { InputPayload } from '../../../shared/src/types/input.js';
import { createArenaColliders } from './arena.js';
import {
  applyCarPhysics,
  createCar,
  createCarPhysicsState,
  getCarMotion,
  recoverCarBodyAfterStep,
  recoverCarBodyBeforeStep,
  resetCarPhysicsState,
  type CarPhysicsState,
} from './car.js';
import { CAR_LINEAR_SPEED_TOLERANCE } from './car-body.js';
import { createWorld, initPhysics } from './world.js';

const NEUTRAL: InputPayload = { throttle: 0, steer: 0, jump: false, boost: false };
const SETTLE_SECONDS = 0.5;
const EPSILON = 1e-5;

interface Scenario {
  world: RAPIER.World;
  car: RAPIER.RigidBody;
  state: CarPhysicsState;
}

interface DisposalTracker {
  created: number;
  freed: number;
}

const disposalTracker: DisposalTracker = { created: 0, freed: 0 };

function tuning(id: string): number {
  return getScalarTuningValue(DEFAULT_TUNING_REGISTRY_SNAPSHOT, id);
}

function assertApproximately(actual: number, expected: number, label: string): void {
  assert.ok(
    Math.abs(actual - expected) <= EPSILON,
    `${label}: expected ${expected}, received ${actual}`,
  );
}

function assertDirectionPreserved(
  before: { x: number; y: number; z: number },
  after: { x: number; y: number; z: number },
  label: string,
): void {
  const beforeLength = Math.hypot(before.x, before.y, before.z);
  const afterLength = Math.hypot(after.x, after.y, after.z);
  assert.ok(beforeLength > 0 && afterLength > 0, `${label} vectors must be non-zero`);
  assertApproximately(after.x / afterLength, before.x / beforeLength, `${label} x`);
  assertApproximately(after.y / afterLength, before.y / beforeLength, `${label} y`);
  assertApproximately(after.z / afterLength, before.z / beforeLength, `${label} z`);
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

function step(scenario: Scenario, input: InputPayload): void {
  recoverCarBodyBeforeStep(scenario.car);
  applyCarPhysics(scenario.world, scenario.car, input, scenario.state);
  scenario.world.step();
  recoverCarBodyAfterStep(scenario.car);
}

function createScenario(position: { x: number; z: number } = { x: 0, z: -22 }): Scenario {
  const world = createTrackedWorld();
  let ownershipTransferred = false;
  try {
    createArenaColliders(world, ARENA_COLLISION_GEOMETRY);
    const car = createCar(world, {
      x: position.x,
      y: tuning(TUNING_IDS.car.collider.height) / 2
        + getConstant('ARENA.KICKOFF.SPAWN_CLEARANCE'),
      z: position.z,
    });
    const state = createCarPhysicsState();
    const settleFrames = Math.round(
      SETTLE_SECONDS / tuning(TUNING_IDS.physics.fixedStepSeconds),
    );

    for (let frame = 0; frame < settleFrames; frame++) {
      recoverCarBodyBeforeStep(car);
      world.step();
      recoverCarBodyAfterStep(car);
    }
    resetCarPhysicsState(state);
    ownershipTransferred = true;
    return { world, car, state };
  } finally {
    if (!ownershipTransferred) freeTrackedWorld(world);
  }
}

function disposeScenario(scenario: Scenario): void {
  freeTrackedWorld(scenario.world);
}

function forwardSpeed(car: RAPIER.RigidBody): number {
  return getCarMotion(car).forwardSpeed;
}

function runConstructionAndRecovery(): { linearSpeed: number; angularSpeed: number } {
  const scenario = createScenario();
  try {
    const { car, world } = scenario;
    const collider = car.collider(0);
    assert.ok(collider, 'car must own exactly one collider');
    assert.equal(car.numColliders(), 1, 'car must own exactly one collider');
    assert.equal(collider.shape.type, RAPIER.ShapeType.Cuboid, 'car collider must be a plain box');
    const halfExtents = (collider.shape as RAPIER.Cuboid).halfExtents;
    assertApproximately(
      halfExtents.x,
      tuning(TUNING_IDS.car.collider.width) / 2,
      'car half-width',
    );
    assertApproximately(
      halfExtents.y,
      tuning(TUNING_IDS.car.collider.height) / 2,
      'car half-height',
    );
    assertApproximately(
      halfExtents.z,
      tuning(TUNING_IDS.car.collider.length) / 2,
      'car half-length',
    );
    assertApproximately(car.mass(), 150, 'car body mass');
    assertApproximately(collider.mass(), 150, 'car collider mass');
    assert.equal(car.isCcdEnabled(), true, 'car CCD must remain enabled');
    assert.deepEqual(
      { x: world.gravity.x, y: world.gravity.y, z: world.gravity.z },
      { x: 0, y: -6.5, z: 0 },
      'metric world gravity must be exact',
    );

    const initial = recoverCarBodyBeforeStep(car);
    car.setLinvel({ x: Number.NEGATIVE_INFINITY, y: 2, z: 3 }, true);
    car.setAngvel({ x: 1, y: 2, z: 2 }, true);
    const recovered = recoverCarBodyBeforeStep(car);
    assert.deepEqual(
      recovered.linearVelocity,
      initial.linearVelocity,
      'invalid car linear velocity must use its own last-finite value',
    );
    assert.deepEqual(
      recovered.angularVelocity,
      { x: 1, y: 2, z: 2 },
      'valid car angular velocity must survive linear-velocity recovery',
    );

    const baselineTranslation = recovered.translation;
    car.setTranslation({ x: Number.NaN, y: 1, z: 2 }, true);
    car.setRotation({ x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 }, true);
    const recoveredTransform = recoverCarBodyBeforeStep(car);
    assert.deepEqual(
      recoveredTransform.translation,
      baselineTranslation,
      'invalid car translation must use its own last-finite value',
    );
    assertApproximately(
      recoveredTransform.rotation.y,
      Math.SQRT1_2,
      'valid car rotation must survive translation recovery',
    );

    const requestedLinearVelocity = { x: 30, y: 40, z: 0 };
    const requestedAngularVelocity = { x: 6, y: 8, z: 0 };
    car.setLinvel(requestedLinearVelocity, true);
    car.setAngvel(requestedAngularVelocity, true);
    const bounded = recoverCarBodyAfterStep(car);
    const linearSpeed = Math.hypot(
      bounded.linearVelocity.x,
      bounded.linearVelocity.y,
      bounded.linearVelocity.z,
    );
    const angularSpeed = Math.hypot(
      bounded.angularVelocity.x,
      bounded.angularVelocity.y,
      bounded.angularVelocity.z,
    );
    assert.ok(
      linearSpeed <= tuning(TUNING_IDS.car.maxLinearSpeed)
        + CAR_LINEAR_SPEED_TOLERANCE
        + EPSILON,
      'post-step car linear speed must be at most 23.05 m/s',
    );
    assert.ok(
      angularSpeed <= tuning(TUNING_IDS.car.maxAngularSpeed) + EPSILON,
      'post-step car angular speed must be at most 5.5 rad/s',
    );
    assertDirectionPreserved(
      requestedLinearVelocity,
      bounded.linearVelocity,
      'car linear cap',
    );
    assertDirectionPreserved(
      requestedAngularVelocity,
      bounded.angularVelocity,
      'car angular cap',
    );
    return { linearSpeed, angularSpeed };
  } finally {
    disposeScenario(scenario);
  }
}

function runAcceleration(): { oneSecond: number; twoSeconds: number; final: number } {
  const scenario = createScenario();
  try {
    const timestep = tuning(TUNING_IDS.physics.fixedStepSeconds);
    const frames = Math.round(2.25 / timestep);
    const oneSecondFrame = Math.round(1 / timestep) - 1;
    const twoSecondFrame = Math.round(2 / timestep) - 1;
    const input: InputPayload = { throttle: 1, steer: 0, jump: false, boost: false };
    let oneSecond = 0;
    let twoSeconds = 0;

    for (let frame = 0; frame < frames; frame++) {
      step(scenario, input);
      if (frame === oneSecondFrame) oneSecond = forwardSpeed(scenario.car);
      if (frame === twoSecondFrame) twoSeconds = forwardSpeed(scenario.car);
    }

    const final = forwardSpeed(scenario.car);
    const cap = getConstant('CAR.ENGINE.MAX_SPEED');
    assert.ok(oneSecond > cap * 0.55, `acceleration is sluggish: 1s=${oneSecond.toFixed(2)}m/s`);
    assert.ok(twoSeconds > cap * 0.78, `car should approach cap by 2s: ${twoSeconds.toFixed(2)}m/s`);
    assert.ok(final >= cap * 0.9 && final <= cap * 1.05, `normal cap unstable: ${final.toFixed(2)}m/s`);
    return { oneSecond, twoSeconds, final };
  } finally {
    disposeScenario(scenario);
  }
}

function runBoost(): { peak: number; consumed: number; remaining: number } {
  const scenario = createScenario();
  try {
    const timestep = tuning(TUNING_IDS.physics.fixedStepSeconds);
    const throttle: InputPayload = { throttle: 1, steer: 0, jump: false, boost: false };
    const boost: InputPayload = { ...throttle, boost: true };

    for (let frame = 0; frame < Math.round(2 / timestep); frame++) step(scenario, throttle);
    const position = scenario.car.translation();
    scenario.car.setTranslation({ x: position.x, y: position.y, z: -20 }, true);
    scenario.world.updateSceneQueries();
    resetCarPhysicsState(scenario.state);
    const startingBoost = scenario.state.boostAmount;
    let peak = 0;
    const boostSeconds = 1;

    for (let frame = 0; frame < Math.round(boostSeconds / timestep); frame++) {
      step(scenario, boost);
      peak = Math.max(peak, getCarMotion(scenario.car).horizontalSpeed);
    }

    const remaining = scenario.state.boostAmount;
    const consumed = startingBoost - remaining;
    const expectedConsumption = getConstant('CAR.BOOST.USAGE_RATE') * boostSeconds;
    const authoritativeCap = tuning(TUNING_IDS.car.maxLinearSpeed)
      + CAR_LINEAR_SPEED_TOLERANCE;
    assert.ok(
      peak >= authoritativeCap - 0.1,
      `boost should reach the authoritative cap: ${peak.toFixed(2)}m/s`,
    );
    assert.ok(
      peak <= authoritativeCap + EPSILON,
      `boost must respect the authoritative cap: ${peak.toFixed(2)}m/s`,
    );
    assert.ok(Math.abs(consumed - expectedConsumption) <= 0.5, `boost consumption ${consumed.toFixed(2)} != ${expectedConsumption.toFixed(2)}`);
    assert.ok(remaining >= 0, 'boost amount cannot become negative');
    return { peak, consumed, remaining };
  } finally {
    disposeScenario(scenario);
  }
}

function runBrakeReverse(): { entry: number; stopSeconds: number; reverse: number } {
  const scenario = createScenario();
  try {
    const timestep = tuning(TUNING_IDS.physics.fixedStepSeconds);
    const forward: InputPayload = { throttle: 1, steer: 0, jump: false, boost: false };
    const reverseInput: InputPayload = { throttle: -1, steer: 0, jump: false, boost: false };

    for (let frame = 0; frame < Math.round(2.5 / timestep); frame++) step(scenario, forward);
    const entry = forwardSpeed(scenario.car);
    let stopFrame = -1;

    for (let frame = 0; frame < Math.round(1.5 / timestep); frame++) {
      step(scenario, reverseInput);
      if (stopFrame < 0 && forwardSpeed(scenario.car) <= 0) stopFrame = frame;
    }
    for (let frame = 0; frame < Math.round(2 / timestep); frame++) step(scenario, reverseInput);

    const reverse = forwardSpeed(scenario.car);
    const stopSeconds = (stopFrame + 1) * timestep;
    assert.ok(stopFrame >= 0, 'brakes must stop forward travel before reversing');
    assert.ok(stopSeconds < 1.1, `braking is too weak: ${stopSeconds.toFixed(2)}s`);
    assert.ok(reverse < -getConstant('CAR.ENGINE.REVERSE_MAX_SPEED') * 0.7, `reverse is too weak: ${reverse.toFixed(2)}m/s`);
    assert.ok(reverse >= -getConstant('CAR.ENGINE.REVERSE_MAX_SPEED') * 1.05, `reverse cap unstable: ${reverse.toFixed(2)}m/s`);
    return { entry, stopSeconds, reverse };
  } finally {
    disposeScenario(scenario);
  }
}

function runSteering(): { turnAngle: number; xTravel: number; zTravel: number; maxSlipRatio: number } {
  const scenario = createScenario({ x: -10, z: -22 });
  try {
    const timestep = tuning(TUNING_IDS.physics.fixedStepSeconds);
    const forward: InputPayload = { throttle: 1, steer: 0, jump: false, boost: false };
    const turn: InputPayload = { throttle: 1, steer: 1, jump: false, boost: false };

    for (let frame = 0; frame < Math.round(1.5 / timestep); frame++) step(scenario, forward);
    const startPosition = { ...scenario.car.translation() };
    const startForward = getCarMotion(scenario.car).forward;
    let maxSlipRatio = 0;

    for (let frame = 0; frame < Math.round(1.5 / timestep); frame++) {
      step(scenario, turn);
      const motion = getCarMotion(scenario.car);
      maxSlipRatio = Math.max(
        maxSlipRatio,
        Math.abs(motion.lateralSpeed) / Math.max(motion.horizontalSpeed, 1),
      );
    }

    const endPosition = scenario.car.translation();
    const endForward = getCarMotion(scenario.car).forward;
    const headingDot = Math.min(Math.max(
      startForward.x * endForward.x + startForward.z * endForward.z,
      -1,
    ), 1);
    const turnAngle = Math.acos(headingDot);
    const xTravel = Math.abs(endPosition.x - startPosition.x);
    const zTravel = Math.abs(endPosition.z - startPosition.z);
    assert.ok(turnAngle > 0.8, `high-speed steering lacks authority: ${turnAngle.toFixed(2)}rad`);
    assert.ok(xTravel > 4 && zTravel > 2, `car did not follow a usable arc: x=${xTravel.toFixed(2)} z=${zTravel.toFixed(2)}`);
    assert.ok(maxSlipRatio < 0.55, `lateral slip is uncontrolled: ratio=${maxSlipRatio.toFixed(2)}`);
    return { turnAngle, xTravel, zTravel, maxSlipRatio };
  } finally {
    disposeScenario(scenario);
  }
}

function runJump(): { apex: number; landingSeconds: number; secondJumpVy: number; airAngularSpeed: number } {
  const scenario = createScenario();
  try {
    const timestep = tuning(TUNING_IDS.physics.fixedStepSeconds);
    const startY = scenario.car.translation().y;
    const heldJump: InputPayload = { throttle: 0, steer: 0, jump: true, boost: false };
    let apex = startY;
    let airborneSeen = false;
    let landingFrame = -1;

    for (let frame = 0; frame < Math.round(3 / timestep); frame++) {
      step(scenario, heldJump);
      apex = Math.max(apex, scenario.car.translation().y);
      airborneSeen ||= !scenario.state.grounded;
      if (airborneSeen && scenario.state.grounded && scenario.state.count === 0) {
        landingFrame = frame;
        break;
      }
    }

    assert.ok(apex - startY > 1, `jump apex is too low: ${(apex - startY).toFixed(2)}m`);
    assert.ok(landingFrame >= 0, 'jump must land and rearm within the test window');

    let heldPeakAfterLanding = scenario.car.translation().y;
    for (let frame = 0; frame < Math.round(0.5 / timestep); frame++) {
      step(scenario, heldJump);
      heldPeakAfterLanding = Math.max(heldPeakAfterLanding, scenario.car.translation().y);
    }
    assert.ok(
      heldPeakAfterLanding <= startY + getConstant('CAR.GROUND.CONTACT_MARGIN'),
      'holding jump must not retrigger after landing',
    );

    step(scenario, NEUTRAL);
    step(scenario, heldJump);
    const secondJumpVy = scenario.car.linvel().y;
    assert.ok(scenario.state.count === 1 && secondJumpVy > 2, 'release then press must trigger the rearmed jump');

    const airControl: InputPayload = { throttle: 1, steer: 1, jump: false, boost: false };
    for (let frame = 0; frame < Math.round(0.35 / timestep); frame++) step(scenario, airControl);
    const angularVelocity = scenario.car.angvel();
    const airAngularSpeed = Math.hypot(angularVelocity.x, angularVelocity.y, angularVelocity.z);
    assert.ok(airAngularSpeed > 1, `air control is ineffective: ${airAngularSpeed.toFixed(2)}rad/s`);
    assert.ok(
      airAngularSpeed <= tuning(TUNING_IDS.car.maxAngularSpeed) + EPSILON,
      'air control must respect the global car angular cap',
    );

    return {
      apex: apex - startY,
      landingSeconds: (landingFrame + 1) * timestep,
      secondJumpVy,
      airAngularSpeed,
    };
  } finally {
    disposeScenario(scenario);
  }
}

function assertSetupFailureCleanup(): void {
  assert.throws(() => {
    const world = createTrackedWorld();
    try {
      createCar(world, { x: 0, y: 1, z: 0 });
      throw new Error('synthetic car setup assertion failure');
    } finally {
      freeTrackedWorld(world);
    }
  }, /synthetic car setup assertion failure/);
}

async function main(): Promise<void> {
  await initPhysics();
  const construction = runConstructionAndRecovery();
  const acceleration = runAcceleration();
  const boost = runBoost();
  const brakeReverse = runBrakeReverse();
  const steering = runSteering();
  const jump = runJump();
  assertSetupFailureCleanup();
  assert.equal(
    disposalTracker.freed,
    disposalTracker.created,
    'every car-harness Rapier world must be freed',
  );

  console.log('=== CAR HARNESS: PASS ===');
  console.log(`body caps: linear=${construction.linearSpeed.toFixed(2)}m/s angular=${construction.angularSpeed.toFixed(2)}rad/s`);
  console.log(`accel: 1s=${acceleration.oneSecond.toFixed(2)} 2s=${acceleration.twoSeconds.toFixed(2)} final=${acceleration.final.toFixed(2)}m/s`);
  console.log(`boost: peak=${boost.peak.toFixed(2)}m/s consumed=${boost.consumed.toFixed(1)} remaining=${boost.remaining.toFixed(1)}`);
  console.log(`brake/reverse: entry=${brakeReverse.entry.toFixed(2)} stop=${brakeReverse.stopSeconds.toFixed(2)}s reverse=${brakeReverse.reverse.toFixed(2)}m/s`);
  console.log(`steer: angle=${steering.turnAngle.toFixed(2)}rad arc=(${steering.xTravel.toFixed(2)}, ${steering.zTravel.toFixed(2)})m maxSlip=${steering.maxSlipRatio.toFixed(2)}`);
  console.log(`jump: apex=${jump.apex.toFixed(2)}m land=${jump.landingSeconds.toFixed(2)}s secondVy=${jump.secondJumpVy.toFixed(2)} airControl=${jump.airAngularSpeed.toFixed(2)}rad/s`);
  console.log(`cleanup=${disposalTracker.freed}/${disposalTracker.created} worlds`);
}

main().catch((error: unknown) => {
  console.error('=== CAR HARNESS: FAIL ===');
  console.error(error);
  process.exitCode = 1;
});
