import assert from 'node:assert/strict';
import type RAPIER from '@dimforge/rapier3d-compat';
import { getConstant } from '../../../shared/src/constants/index.js';
import type { InputPayload } from '../../../shared/src/types/input.js';
import { createArenaColliders } from './arena.js';
import {
  applyCarPhysics,
  createCar,
  createCarPhysicsState,
  getCarMotion,
  resetCarPhysicsState,
  type CarPhysicsState,
} from './car.js';
import { createWorld, initPhysics } from './world.js';

const NEUTRAL: InputPayload = { throttle: 0, steer: 0, jump: false, boost: false };
const SETTLE_SECONDS = 0.5;

interface Scenario {
  world: RAPIER.World;
  car: RAPIER.RigidBody;
  state: CarPhysicsState;
}

function step(scenario: Scenario, input: InputPayload): void {
  applyCarPhysics(scenario.world, scenario.car, input, scenario.state);
  scenario.world.step();
}

function createScenario(position: { x: number; z: number } = { x: 0, z: -22 }): Scenario {
  const world = createWorld();
  createArenaColliders(world);
  const car = createCar(world, {
    x: position.x,
    y: getConstant('CAR.BODY.HEIGHT') / 2
      + getConstant('ARENA.KICKOFF.SPAWN_CLEARANCE'),
    z: position.z,
  });
  const state = createCarPhysicsState();
  const settleFrames = Math.round(SETTLE_SECONDS / getConstant('PHYSICS.TIMESTEP'));

  for (let frame = 0; frame < settleFrames; frame++) world.step();
  resetCarPhysicsState(state);
  return { world, car, state };
}

function forwardSpeed(car: RAPIER.RigidBody): number {
  return getCarMotion(car).forwardSpeed;
}

function runAcceleration(): { oneSecond: number; twoSeconds: number; final: number } {
  const scenario = createScenario();
  const timestep = getConstant('PHYSICS.TIMESTEP');
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

  scenario.world.free();
  return { oneSecond, twoSeconds, final };
}

function runBoost(): { peak: number; consumed: number; remaining: number } {
  const scenario = createScenario();
  const timestep = getConstant('PHYSICS.TIMESTEP');
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
  const boostCap = getConstant('CAR.BOOST.MAX_SPEED');

  assert.ok(peak > getConstant('CAR.ENGINE.MAX_SPEED') * 1.15, `boost lacks separation: ${peak.toFixed(2)}m/s`);
  assert.ok(peak <= boostCap * 1.05, `boost cap unstable: ${peak.toFixed(2)}m/s`);
  assert.ok(Math.abs(consumed - expectedConsumption) <= 0.5, `boost consumption ${consumed.toFixed(2)} != ${expectedConsumption.toFixed(2)}`);
  assert.ok(remaining >= 0, 'boost amount cannot become negative');

  scenario.world.free();
  return { peak, consumed, remaining };
}

function runBrakeReverse(): { entry: number; stopSeconds: number; reverse: number } {
  const scenario = createScenario();
  const timestep = getConstant('PHYSICS.TIMESTEP');
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

  scenario.world.free();
  return { entry, stopSeconds, reverse };
}

function runSteering(): { turnAngle: number; xTravel: number; zTravel: number; maxSlipRatio: number } {
  const scenario = createScenario({ x: -10, z: -22 });
  const timestep = getConstant('PHYSICS.TIMESTEP');
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

  scenario.world.free();
  return { turnAngle, xTravel, zTravel, maxSlipRatio };
}

function runJump(): { apex: number; landingSeconds: number; secondJumpVy: number; airAngularSpeed: number } {
  const scenario = createScenario();
  const timestep = getConstant('PHYSICS.TIMESTEP');
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

  scenario.world.free();
  return {
    apex: apex - startY,
    landingSeconds: (landingFrame + 1) * timestep,
    secondJumpVy,
    airAngularSpeed,
  };
}

async function main(): Promise<void> {
  await initPhysics();
  const acceleration = runAcceleration();
  const boost = runBoost();
  const brakeReverse = runBrakeReverse();
  const steering = runSteering();
  const jump = runJump();

  console.log('=== CAR HARNESS: PASS ===');
  console.log(`accel: 1s=${acceleration.oneSecond.toFixed(2)} 2s=${acceleration.twoSeconds.toFixed(2)} final=${acceleration.final.toFixed(2)}m/s`);
  console.log(`boost: peak=${boost.peak.toFixed(2)}m/s consumed=${boost.consumed.toFixed(1)} remaining=${boost.remaining.toFixed(1)}`);
  console.log(`brake/reverse: entry=${brakeReverse.entry.toFixed(2)} stop=${brakeReverse.stopSeconds.toFixed(2)}s reverse=${brakeReverse.reverse.toFixed(2)}m/s`);
  console.log(`steer: angle=${steering.turnAngle.toFixed(2)}rad arc=(${steering.xTravel.toFixed(2)}, ${steering.zTravel.toFixed(2)})m maxSlip=${steering.maxSlipRatio.toFixed(2)}`);
  console.log(`jump: apex=${jump.apex.toFixed(2)}m land=${jump.landingSeconds.toFixed(2)}s secondVy=${jump.secondJumpVy.toFixed(2)} airControl=${jump.airAngularSpeed.toFixed(2)}rad/s`);
}

main().catch((error: unknown) => {
  console.error('=== CAR HARNESS: FAIL ===');
  console.error(error);
  process.exitCode = 1;
});
