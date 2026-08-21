import assert from 'node:assert/strict';
import RAPIER from '@dimforge/rapier3d-compat';
import {
  ARENA_GEOMETRY_SPEC,
  DEFAULT_TUNING_REGISTRY_SNAPSHOT,
  INPUT_PROTOCOL_VERSION,
  TUNING_IDS,
  getScalarTuningValue,
  type InputCommandV2,
} from '@rocket-arena/shared';
import {
  createCarJumpAirState,
  planCarControllerCommand,
  planJumpAirControl,
  synchronizeCarJumpAirState,
  type CarControllerObservation,
  type CarJumpAirState,
  type ControllerQuaternion,
  type ControllerVector3,
  type JumpAirControlPlan,
} from './car-controller.js';
import { ArenaSurfaceRegistry, detectGroundSupport } from './grounding.js';
import { initPhysics } from './world.js';

const EPSILON = 1e-8;
const TIMESTEP = getScalarTuningValue(
  DEFAULT_TUNING_REGISTRY_SNAPSHOT,
  TUNING_IDS.physics.fixedStepSeconds,
);
const FIRST_JUMP_DELTA = getScalarTuningValue(
  DEFAULT_TUNING_REGISTRY_SNAPSHOT,
  TUNING_IDS.car.jump.firstVelocityChange,
);
const HOLD_FORCE = getScalarTuningValue(
  DEFAULT_TUNING_REGISTRY_SNAPSHOT,
  TUNING_IDS.car.jump.holdForce,
);
const CAR_MASS = getScalarTuningValue(
  DEFAULT_TUNING_REGISTRY_SNAPSHOT,
  TUNING_IDS.car.mass,
);
const CAR_HALF_LENGTH = getScalarTuningValue(
  DEFAULT_TUNING_REGISTRY_SNAPSHOT,
  TUNING_IDS.car.collider.length,
) / 2;
const CAR_HALF_WIDTH = getScalarTuningValue(
  DEFAULT_TUNING_REGISTRY_SNAPSHOT,
  TUNING_IDS.car.collider.width,
) / 2;
const CAR_HALF_HEIGHT = getScalarTuningValue(
  DEFAULT_TUNING_REGISTRY_SNAPSHOT,
  TUNING_IDS.car.collider.height,
) / 2;
const MAX_ANGULAR_SPEED = getScalarTuningValue(
  DEFAULT_TUNING_REGISTRY_SNAPSHOT,
  TUNING_IDS.car.maxAngularSpeed,
);
const PITCH_TORQUE = getScalarTuningValue(
  DEFAULT_TUNING_REGISTRY_SNAPSHOT,
  TUNING_IDS.car.air.pitchTorque,
);
const YAW_TORQUE = getScalarTuningValue(
  DEFAULT_TUNING_REGISTRY_SNAPSHOT,
  TUNING_IDS.car.air.yawTorque,
);
const ROLL_TORQUE = getScalarTuningValue(
  DEFAULT_TUNING_REGISTRY_SNAPSHOT,
  TUNING_IDS.car.air.rollTorque,
);
const ROLL_DAMPING = getScalarTuningValue(
  DEFAULT_TUNING_REGISTRY_SNAPSHOT,
  TUNING_IDS.car.air.rollDamping,
);
const IDENTITY: ControllerQuaternion = { x: 0, y: 0, z: 0, w: 1 };
const NEUTRAL: Readonly<InputCommandV2> = Object.freeze({
  protocolVersion: INPUT_PROTOCOL_VERSION,
  throttle: 0,
  steer: 0,
  pitch: 0,
  yaw: 0,
  roll: 0,
  jumpHeld: false,
  jumpSequence: 0,
  boostHeld: false,
  powerslideHeld: false,
  cameraToggleSequence: 0,
});
const disposalTracker = { created: 0, freed: 0 };

function command(patch: Partial<InputCommandV2>): Readonly<InputCommandV2> {
  return Object.freeze({ ...NEUTRAL, ...patch });
}

function observation(
  grounded: boolean,
  rotation: ControllerQuaternion = IDENTITY,
  linearVelocity: ControllerVector3 = { x: 0, y: 0, z: 0 },
  angularVelocity: ControllerVector3 = { x: 0, y: 0, z: 0 },
): CarControllerObservation {
  return {
    rotation,
    linearVelocity,
    angularVelocity,
    grounded,
    surfaceBasis: grounded
      ? {
        normal: { x: 0, y: 1, z: 0 },
        forward: { x: 0, y: 0, z: 1 },
        right: { x: 1, y: 0, z: 0 },
      }
      : null,
  };
}

function planAt(
  input: Readonly<InputCommandV2>,
  state: Readonly<CarJumpAirState>,
  fixedStepIndex: number,
  grounded: boolean,
  rotation: ControllerQuaternion = IDENTITY,
  angularVelocity: ControllerVector3 = { x: 0, y: 0, z: 0 },
): Readonly<JumpAirControlPlan> {
  return planJumpAirControl(input, state, {
    observation: observation(grounded, rotation, { x: 0, y: 0, z: 0 }, angularVelocity),
    fixedStepIndex,
    timestepSeconds: TIMESTEP,
  });
}

/**
 * Hold one axis from rest and report how long it takes to reach a share of the
 * maximum angular speed, plus the rate it settles at.
 */
function spinUpAxis(
  axis: 'pitch' | 'yaw' | 'roll',
  steps: number,
): { readonly stepsToNearMax: number; readonly finalRate: number } {
  const state = createCarJumpAirState(5);
  const readRate = (plan: Readonly<JumpAirControlPlan>): number => (
    axis === 'pitch'
      ? plan.airAngularVelocity.x
      : axis === 'yaw' ? plan.airAngularVelocity.y : plan.airAngularVelocity.z
  );
  let angularVelocity: ControllerVector3 = { x: 0, y: 0, z: 0 };
  let stepsToNearMax = Number.POSITIVE_INFINITY;
  let finalRate = 0;
  for (let step = 0; step < steps; step += 1) {
    const plan = planAt(
      command({ [axis]: 1, jumpSequence: 5 } as Partial<InputCommandV2>),
      state,
      step,
      false,
      IDENTITY,
      angularVelocity,
    );
    angularVelocity = plan.airAngularVelocity;
    finalRate = readRate(plan);
    if (finalRate >= MAX_ANGULAR_SPEED * 0.99 && !Number.isFinite(stepsToNearMax)) {
      stepsToNearMax = step + 1;
    }
  }
  return { stepsToNearMax, finalRate };
}

function assertApproximately(actual: number, expected: number, label: string): void {
  assert.ok(
    Math.abs(actual - expected) <= EPSILON,
    `${label}: expected ${expected}, received ${actual}`,
  );
}

function assertVectorApproximately(
  actual: ControllerVector3,
  expected: ControllerVector3,
  label: string,
): void {
  assertApproximately(actual.x, expected.x, `${label}.x`);
  assertApproximately(actual.y, expected.y, `${label}.y`);
  assertApproximately(actual.z, expected.z, `${label}.z`);
}

function vectorMagnitude(vector: ControllerVector3): number {
  return Math.hypot(vector.x, vector.y, vector.z);
}

function vectorDot(left: ControllerVector3, right: ControllerVector3): number {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

function startFirstJump(jumpHeld = true): Readonly<JumpAirControlPlan> {
  return planAt(
    command({ jumpHeld, jumpSequence: 1 }),
    createCarJumpAirState(),
    0,
    true,
  );
}

function runFirstJumpAndHoldCases(): void {
  const first = startFirstJump(true);
  assert.equal(first.event, 'first-jump');
  assertVectorApproximately(
    first.jumpDeltaVelocity,
    { x: 0, y: FIRST_JUMP_DELTA, z: 0 },
    'first jump Local_Roof delta',
  );
  assert.equal(first.nextState.lastConsumedJumpSequence, 1);
  assert.equal(first.nextState.firstJumpAcceptedAtStep, 0);
  assert.equal(first.nextState.airborneSinceFirstJump, false);
  assert.equal(first.nextState.secondJumpAvailable, true);
  assert.ok(Object.isFrozen(first.nextState));
  assertVectorApproximately(first.holdForce, { x: 0, y: HOLD_FORCE, z: 0 }, 'first hold force');
  assertApproximately(
    first.holdDeltaVelocity.y,
    HOLD_FORCE / CAR_MASS * TIMESTEP,
    'first hold integration',
  );

  const repeated = planAt(
    command({ jumpHeld: true, jumpSequence: 1 }),
    first.nextState,
    1,
    false,
  );
  assert.equal(repeated.event, 'none');
  assert.equal(repeated.nextState.airborneSinceFirstJump, true);
  assert.equal(vectorMagnitude(repeated.jumpDeltaVelocity), 0, 'repeated heartbeat cannot jump');

  const atEleven = planAt(
    command({ jumpHeld: true, jumpSequence: 1 }),
    first.nextState,
    11,
    false,
  );
  assert.ok(atEleven.holdDeltaVelocity.y > 0, 'hold must remain active immediately before expiry');
  const atTwelve = planAt(
    command({ jumpHeld: true, jumpSequence: 1 }),
    first.nextState,
    12,
    false,
  );
  assert.equal(vectorMagnitude(atTwelve.holdDeltaVelocity), 0, 'hold must stop at exact 0.2s');
  assert.equal(atTwelve.nextState.firstJumpHeld, false, 'expired hold latch must clear');

  const released = planAt(
    command({ jumpHeld: false, jumpSequence: 1 }),
    first.nextState,
    5,
    false,
  );
  assert.equal(released.nextState.firstJumpHeld, false);
  const cannotResume = planAt(
    command({ jumpHeld: true, jumpSequence: 1 }),
    released.nextState,
    6,
    false,
  );
  assert.equal(vectorMagnitude(cannotResume.holdDeltaVelocity), 0, 'same edge cannot resume hold');

  const rapidTap = startFirstJump(false);
  assert.equal(rapidTap.event, 'first-jump');
  assert.equal(vectorMagnitude(rapidTap.jumpDeltaVelocity), FIRST_JUMP_DELTA);
  assert.equal(vectorMagnitude(rapidTap.holdDeltaVelocity), 0);

  const rotated = planAt(
    command({ jumpSequence: 1 }),
    createCarJumpAirState(),
    0,
    true,
    { x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 },
  );
  assertVectorApproximately(
    rotated.jumpDeltaVelocity,
    { x: -FIRST_JUMP_DELTA, y: 0, z: 0 },
    'rotated Local_Roof jump',
  );
}

function runSecondJumpBoundaryCases(): void {
  for (const [offset, expectedEvent] of [
    [74, 'second-jump'],
    [75, 'second-jump'],
    [76, 'edge-discarded'],
  ] as const) {
    const first = startFirstJump(false);
    const second = planAt(
      command({ jumpSequence: 2 }),
      first.nextState,
      offset,
      false,
    );
    assert.equal(second.event, expectedEvent, `second jump boundary offset ${offset}`);
    assert.equal(second.nextState.lastConsumedJumpSequence, 2);
    assert.equal(
      vectorMagnitude(second.jumpDeltaVelocity),
      expectedEvent === 'second-jump' ? FIRST_JUMP_DELTA : 0,
    );
    const repeat = planAt(command({ jumpSequence: 2 }), second.nextState, offset, false);
    assert.equal(repeat.event, 'none', 'repeated second edge must be idempotent');
    assert.equal(vectorMagnitude(repeat.jumpDeltaVelocity), 0);
  }
}

function runFlipCases(): { activeAngularSpeed: number } {
  const first = startFirstJump(false);
  const belowDeadzone = planAt(
    command({ jumpSequence: 2, pitch: 0.299999 }),
    first.nextState,
    10,
    false,
  );
  assert.equal(belowDeadzone.event, 'second-jump');

  const exactDeadzone = planAt(
    command({ jumpSequence: 2, pitch: 0.3 }),
    first.nextState,
    10,
    false,
  );
  assert.equal(exactDeadzone.event, 'flip-start');
  assert.equal(exactDeadzone.flipActive, true);
  assertApproximately(vectorMagnitude(exactDeadzone.jumpDeltaVelocity), FIRST_JUMP_DELTA, 'flip delta bound');

  const directional = planAt(
    command({ jumpSequence: 2, pitch: 0.3, roll: 0.4 }),
    first.nextState,
    10,
    false,
  );
  assert.equal(directional.event, 'flip-start');
  assert.deepEqual(directional.nextState.activeFlipDirection, [0.6, 0.8]);
  assert.equal(directional.nextState.secondJumpAvailable, false);

  const locked = planAt(
    command({ jumpSequence: 2, pitch: -1, roll: -1 }),
    directional.nextState,
    11,
    false,
  );
  assert.deepEqual(locked.nextState.activeFlipDirection, [0.6, 0.8]);
  assert.ok(vectorDot(locked.airAngularTarget, locked.localRight) > 0);
  assert.ok(vectorDot(locked.airAngularTarget, locked.localForward) > 0);

  const beforeExpiry = planAt(
    command({ jumpSequence: 2 }),
    directional.nextState,
    48,
    false,
  );
  assert.equal(beforeExpiry.flipActive, true, 'flip must actuate through offset 38');
  assert.ok(vectorMagnitude(beforeExpiry.airAngularTarget) > 0);
  const atExpiry = planAt(
    command({ jumpSequence: 2 }),
    directional.nextState,
    49,
    false,
  );
  assert.equal(atExpiry.flipActive, false, 'flip must stop at exact offset 39');
  assert.equal(atExpiry.nextState.activeFlipStartedAtStep, null);
  assert.equal(vectorMagnitude(atExpiry.airAngularTarget), 0);
  assert.equal(atExpiry.nextState.secondJumpAvailable, false);

  const lateDuringFlip = planAt(
    command({ jumpSequence: 3 }),
    directional.nextState,
    12,
    false,
  );
  assert.equal(lateDuringFlip.event, 'edge-discarded');
  assert.equal(lateDuringFlip.nextState.lastConsumedJumpSequence, 3);
  assert.equal(lateDuringFlip.nextState.activeFlipStartedAtStep, 10);

  return { activeAngularSpeed: vectorMagnitude(locked.airAngularTarget) };
}

function runGroundResetAndSynchronizationCases(): void {
  const first = startFirstJump(true);
  const flip = planAt(
    command({ jumpSequence: 2, pitch: 1 }),
    first.nextState,
    10,
    false,
  );
  const grounded = planAt(
    command({ jumpHeld: true, jumpSequence: 2, pitch: 1 }),
    flip.nextState,
    20,
    true,
  );
  assert.equal(grounded.event, 'none');
  assert.equal(grounded.nextState.lastConsumedJumpSequence, 2);
  assert.equal(grounded.nextState.firstJumpAcceptedAtStep, null);
  assert.equal(grounded.nextState.activeFlipStartedAtStep, null);
  assert.equal(grounded.nextState.secondJumpAvailable, true);
  assert.equal(vectorMagnitude(grounded.holdDeltaVelocity), 0);
  assert.equal(vectorMagnitude(grounded.airAngularTarget), 0);

  const sameHeldEdge = planAt(
    command({ jumpHeld: true, jumpSequence: 2 }),
    grounded.nextState,
    21,
    true,
  );
  assert.equal(sameHeldEdge.event, 'none', 'landing must not replay held edge');
  const nextEdge = planAt(
    command({ jumpHeld: true, jumpSequence: 3 }),
    sameHeldEdge.nextState,
    22,
    true,
  );
  assert.equal(nextEdge.event, 'first-jump');

  const synchronized = synchronizeCarJumpAirState(
    flip.nextState,
    command({ jumpHeld: true, jumpSequence: 9 }),
  );
  assert.equal(synchronized.lastConsumedJumpSequence, 9);
  assert.equal(synchronized.firstJumpAcceptedAtStep, null);
  assert.equal(synchronized.activeFlipStartedAtStep, null);
  assert.equal(synchronized.secondJumpAvailable, false);
  const disabledReplay = planAt(
    command({ jumpHeld: true, jumpSequence: 9 }),
    synchronized,
    30,
    true,
  );
  assert.equal(disabledReplay.event, 'none');
}

function runAirAxisCases(): void {
  const state = createCarJumpAirState(5);
  const pitch = planAt(command({ pitch: 1, jumpSequence: 5 }), state, 0, false);
  const yaw = planAt(command({ yaw: 1, jumpSequence: 5 }), state, 0, false);
  const roll = planAt(command({ roll: 1, jumpSequence: 5 }), state, 0, false);
  assertVectorApproximately(pitch.airAngularTarget, { x: 5.5, y: 0, z: 0 }, 'identity pitch');
  assertVectorApproximately(yaw.airAngularTarget, { x: 0, y: 5.5, z: 0 }, 'identity yaw');
  assertVectorApproximately(roll.airAngularTarget, { x: 0, y: 0, z: 5.5 }, 'identity roll');

  const diagonal = planAt(
    command({ pitch: 1, yaw: 1, roll: 1, jumpSequence: 5 }),
    state,
    0,
    false,
  );
  assertApproximately(vectorMagnitude(diagonal.airAngularTarget), MAX_ANGULAR_SPEED, 'combined air cap');

  const rotated = planAt(
    command({ yaw: 1, jumpSequence: 5 }),
    state,
    0,
    false,
    { x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 },
  );
  assert.ok(vectorDot(rotated.airAngularTarget, rotated.localRoof) > 5.49);

  const grounded = planAt(
    command({ pitch: 1, yaw: 1, roll: 1, jumpSequence: 5 }),
    state,
    0,
    true,
  );
  assert.equal(vectorMagnitude(grounded.airAngularTarget), 0, 'grounded axes must not actuate air control');

  const malformed = planAt(
    command({ pitch: Number.NaN, yaw: 0.5, roll: -0.25, jumpSequence: Number.NaN }),
    state,
    0,
    false,
  );
  assert.equal(malformed.normalizedPitch, 0);
  assert.equal(malformed.nextState.lastConsumedJumpSequence, 5);
  assert.equal(malformed.event, 'none');
  assertApproximately(vectorDot(malformed.airAngularTarget, malformed.localRight), 0, 'bad pitch neutral');
  assert.ok(vectorDot(malformed.airAngularTarget, malformed.localRoof) > 0);
  assert.ok(vectorDot(malformed.airAngularTarget, malformed.localForward) < 0);
  assert.ok([
    malformed.airAngularTarget.x,
    malformed.airAngularTarget.y,
    malformed.airAngularTarget.z,
  ].every(Number.isFinite));
}

/**
 * Airborne rotation has to spin up and spin down instead of snapping. Roll is
 * the quickest axis, pitch is slower, and yaw is the slowest, which is the
 * asymmetry that makes air control feel like it has mass.
 */
function runAirRampCases(): { readonly rollSteps: number; readonly yawSteps: number } {
  const state = createCarJumpAirState(5);

  // One step from rest is exactly one step of that axis' acceleration.
  const firstPitch = planAt(command({ pitch: 1, jumpSequence: 5 }), state, 0, false);
  const firstYaw = planAt(command({ yaw: 1, jumpSequence: 5 }), state, 0, false);
  const firstRoll = planAt(command({ roll: 1, jumpSequence: 5 }), state, 0, false);
  assertApproximately(firstPitch.airAngularVelocity.x, PITCH_TORQUE * TIMESTEP, 'first pitch step');
  assertApproximately(firstYaw.airAngularVelocity.y, YAW_TORQUE * TIMESTEP, 'first yaw step');
  assertApproximately(firstRoll.airAngularVelocity.z, ROLL_TORQUE * TIMESTEP, 'first roll step');
  for (const plan of [firstPitch, firstYaw, firstRoll]) {
    assert.ok(
      vectorMagnitude(plan.airAngularVelocity) < MAX_ANGULAR_SPEED,
      'a single step must not reach the maximum angular speed',
    );
  }

  const pitch = spinUpAxis('pitch', 120);
  const yaw = spinUpAxis('yaw', 120);
  const roll = spinUpAxis('roll', 120);
  for (const [label, result] of [['pitch', pitch], ['yaw', yaw], ['roll', roll]] as const) {
    assert.ok(
      Number.isFinite(result.stepsToNearMax),
      `${label} must reach the maximum angular speed while held`,
    );
    assert.ok(
      result.finalRate <= MAX_ANGULAR_SPEED + EPSILON,
      `${label} must never exceed the maximum angular speed, received ${result.finalRate}`,
    );
  }
  assert.ok(
    roll.stepsToNearMax < pitch.stepsToNearMax,
    `roll must spin up faster than pitch, received ${roll.stepsToNearMax} vs ${pitch.stepsToNearMax}`,
  );
  assert.ok(
    pitch.stepsToNearMax < yaw.stepsToNearMax,
    `pitch must spin up faster than yaw, received ${pitch.stepsToNearMax} vs ${yaw.stepsToNearMax}`,
  );

  // Releasing the axis decays it toward rest without overshooting past zero.
  let decaying: ControllerVector3 = { x: 0, y: 0, z: MAX_ANGULAR_SPEED };
  let previousRate = decaying.z;
  for (let step = 0; step < 240; step += 1) {
    const plan = planAt(command({ jumpSequence: 5 }), state, step, false, IDENTITY, decaying);
    decaying = plan.airAngularVelocity;
    assert.ok(
      decaying.z >= -EPSILON && decaying.z <= previousRate + EPSILON,
      `released roll must decay monotonically toward rest, received ${decaying.z}`,
    );
    previousRate = decaying.z;
  }
  assert.ok(
    previousRate < MAX_ANGULAR_SPEED * 0.02,
    `released roll must settle near rest, received ${previousRate}`,
  );
  assertApproximately(
    planAt(command({ jumpSequence: 5 }), state, 0, false, IDENTITY, { x: 0, y: 0, z: 1 })
      .airAngularVelocity.z,
    1 - ROLL_DAMPING * 1 * TIMESTEP,
    'one released roll step',
  );

  // Grounded steps stay owned by the grounded steering path.
  assertApproximately(
    vectorMagnitude(
      planAt(command({ pitch: 1, yaw: 1, roll: 1, jumpSequence: 5 }), state, 0, true)
        .airAngularVelocity,
    ),
    0,
    'grounded air rotation',
  );

  return { rollSteps: roll.stepsToNearMax, yawSteps: yaw.stepsToNearMax };
}

function runIntegratedPlannerCase(): void {
  const result = planCarControllerCommand(command({ jumpHeld: true, jumpSequence: 1 }), {
    observation: observation(true),
    availableBoost: 0,
    dragEnabled: false,
    timestepSeconds: TIMESTEP,
    jumpAir: { state: createCarJumpAirState(), fixedStepIndex: 0 },
  });
  assert.equal(result.jumpAirControl?.event, 'first-jump');
  assertApproximately(
    result.projectedVelocity.y,
    FIRST_JUMP_DELTA + HOLD_FORCE / CAR_MASS * TIMESTEP,
    'integrated first jump plus hold',
  );
  assert.equal(result.nextJumpAirState?.lastConsumedJumpSequence, 1);
  assert.equal(vectorMagnitude(result.projectedAngularVelocity), 0);

  const recoveredRotation: ControllerQuaternion = {
    x: 0,
    y: 0,
    z: Math.SQRT1_2,
    w: Math.SQRT1_2,
  };
  const recovered = planCarControllerCommand(command({ yaw: 1, jumpSequence: 5 }), {
    observation: observation(false, { x: Number.NaN, y: 0, z: 0, w: 1 }),
    previousFiniteState: {
      rotation: recoveredRotation,
      linearVelocity: { x: 0, y: 0, z: 0 },
      angularVelocity: { x: 0, y: 0, z: 0 },
    },
    availableBoost: 0,
    dragEnabled: false,
    timestepSeconds: TIMESTEP,
    jumpAir: { state: createCarJumpAirState(5), fixedStepIndex: 1 },
  });
  if (recovered.jumpAirControl === null) throw new Error('jump/air plan was not produced');
  assertVectorApproximately(
    recovered.jumpAirControl.localRoof,
    { x: -1, y: 0, z: 0 },
    'last-finite recovered Local_Roof',
  );
  // Yaw is applied about the recovered Local_Roof, and one step is one step of
  // the yaw ramp rather than a snap to the maximum angular speed.
  assertVectorApproximately(
    recovered.projectedAngularVelocity,
    { x: -YAW_TORQUE * TIMESTEP, y: 0, z: 0 },
    'last-finite recovered yaw',
  );
  assertVectorApproximately(
    recovered.nextFiniteState.rotation,
    recoveredRotation,
    'last-finite recovered rotation',
  );
}

function createTrackedWorld(): RAPIER.World {
  disposalTracker.created += 1;
  return new RAPIER.World({ x: 0, y: 0, z: 0 });
}

function freeTrackedWorld(world: RAPIER.World): void {
  world.free();
  disposalTracker.freed += 1;
}

function runRealGroundingLifecycle(): { residualSupportSteps: number; airborneStep: number } {
  const world = createTrackedWorld();
  try {
    world.timestep = TIMESTEP;
    const floorDescriptor = ARENA_GEOMETRY_SPEC.surfaces.find(
      (surface) => surface.id === 'field.floor',
    );
    if (floorDescriptor === undefined) throw new Error('field.floor descriptor is unavailable');

    const surfaces = new ArenaSurfaceRegistry(world);
    const floor = world.createCollider(
      RAPIER.ColliderDesc.cuboid(2, 0.05, 2).setTranslation(0, -0.05, 0),
    );
    surfaces.register(floor, floorDescriptor);
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(0, CAR_HALF_HEIGHT, 0),
    );
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(
        CAR_HALF_WIDTH,
        CAR_HALF_HEIGHT,
        CAR_HALF_LENGTH,
      ).setMass(CAR_MASS),
      body,
    );

    let state = createCarJumpAirState();
    let residualSupportSteps = 0;
    let airborneStep: number | null = null;
    let secondJumpAccepted = false;
    let lastStep = 0;

    for (let step = 0; step < 30; step += 1) {
      lastStep = step;
      world.updateSceneQueries();
      const support = detectGroundSupport(world, body, surfaces);
      const firstEdge = step === 0;
      const firstAirborneSample = !support.grounded && airborneStep === null;
      const secondEdge = airborneStep !== null
        && step === airborneStep + 1
        && !secondJumpAccepted;
      const input = command({
        jumpHeld: (airborneStep === null && !firstAirborneSample) || secondEdge,
        jumpSequence: firstEdge ? 1 : secondEdge ? 2 : state.lastConsumedJumpSequence,
      });
      const result = planCarControllerCommand(input, {
        observation: {
          rotation: body.rotation(),
          linearVelocity: body.linvel(),
          angularVelocity: body.angvel(),
          grounded: support.grounded,
          surfaceBasis: support.basis,
        },
        previousFiniteState: {
          rotation: body.rotation(),
          linearVelocity: body.linvel(),
          angularVelocity: body.angvel(),
        },
        availableBoost: 0,
        dragEnabled: false,
        timestepSeconds: TIMESTEP,
        jumpAir: { state, fixedStepIndex: step },
      });
      state = result.nextJumpAirState ?? state;

      if (firstEdge) {
        assert.equal(support.grounded, true, 'launch must begin on registered floor support');
        assert.equal(result.jumpAirControl?.event, 'first-jump');
      } else if (support.grounded && airborneStep === null) {
        residualSupportSteps += 1;
        assert.equal(result.jumpAirControl?.event, 'none');
        assert.equal(state.firstJumpAcceptedAtStep, 0, 'residual support must preserve launch origin');
        assert.equal(state.airborneSinceFirstJump, false);
        assert.ok(
          (result.jumpAirControl?.holdDeltaVelocity.y ?? 0) > 0,
          'residual support must not truncate held jump force',
        );
      }

      if (firstAirborneSample) {
        airborneStep = step;
        assert.equal(result.jumpAirControl?.event, 'none');
        assert.equal(state.firstJumpAcceptedAtStep, 0);
        assert.equal(state.airborneSinceFirstJump, true);
        assert.equal(state.secondJumpAvailable, true);
        assert.equal(vectorMagnitude(result.jumpAirControl?.holdDeltaVelocity ?? { x: 0, y: 0, z: 0 }), 0);
      }
      if (secondEdge) {
        assert.equal(support.grounded, false);
        assert.equal(result.jumpAirControl?.event, 'second-jump');
        assert.equal(state.secondJumpAvailable, false);
        secondJumpAccepted = true;
      }

      body.setLinvel(result.projectedVelocity, true);
      body.setAngvel(result.projectedAngularVelocity, true);
      world.step();
      if (secondJumpAccepted) break;
    }

    assert.ok(residualSupportSteps > 0, 'Rapier probe must expose residual launch support');
    assert.ok(airborneStep !== null, 'Rapier probe must leave support range');
    assert.equal(secondJumpAccepted, true, 'second jump must survive residual support');

    body.setTranslation({ x: 0, y: CAR_HALF_HEIGHT, z: 0 }, true);
    body.setRotation(IDENTITY, true);
    body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    world.updateSceneQueries();
    const landingSupport = detectGroundSupport(world, body, surfaces);
    assert.equal(landingSupport.grounded, true, 'teleported probe must reacquire floor support');
    const landing = planCarControllerCommand(
      command({ jumpHeld: true, jumpSequence: state.lastConsumedJumpSequence }),
      {
        observation: {
          rotation: body.rotation(),
          linearVelocity: body.linvel(),
          angularVelocity: body.angvel(),
          grounded: landingSupport.grounded,
          surfaceBasis: landingSupport.basis,
        },
        availableBoost: 0,
        dragEnabled: false,
        timestepSeconds: TIMESTEP,
        jumpAir: { state, fixedStepIndex: lastStep + 1 },
      },
    );
    assert.equal(landing.jumpAirControl?.event, 'none');
    assert.equal(landing.nextJumpAirState?.firstJumpAcceptedAtStep, null);
    assert.equal(landing.nextJumpAirState?.airborneSinceFirstJump, false);
    assert.equal(landing.nextJumpAirState?.secondJumpAvailable, true);
    assert.equal(landing.nextJumpAirState?.lastConsumedJumpSequence, 2);

    return { residualSupportSteps, airborneStep };
  } finally {
    freeTrackedWorld(world);
  }
}

function runRapierSmoke(): { peakHeight: number; peakAngularSpeed: number } {
  const world = createTrackedWorld();
  try {
    world.timestep = TIMESTEP;
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic());
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(
        CAR_HALF_WIDTH,
        CAR_HALF_HEIGHT,
        CAR_HALF_LENGTH,
      ).setMass(CAR_MASS),
      body,
    );
    let state = createCarJumpAirState();
    let peakHeight = 0;
    let peakAngularSpeed = 0;

    for (let step = 0; step < 55; step += 1) {
      const firstJump = step === 0;
      const flip = step === 5;
      const input = command({
        jumpHeld: step < 8,
        jumpSequence: flip ? 2 : firstJump ? 1 : state.lastConsumedJumpSequence,
        pitch: flip ? 1 : 0,
        yaw: step > 5 ? 0.25 : 0,
      });
      const result = planCarControllerCommand(input, {
        observation: observation(
          firstJump,
          body.rotation(),
          body.linvel(),
          body.angvel(),
        ),
        previousFiniteState: {
          rotation: body.rotation(),
          linearVelocity: body.linvel(),
          angularVelocity: body.angvel(),
        },
        availableBoost: 0,
        dragEnabled: false,
        timestepSeconds: TIMESTEP,
        jumpAir: { state, fixedStepIndex: step },
      });
      state = result.nextJumpAirState ?? state;
      body.setLinvel(result.projectedVelocity, true);
      body.setAngvel(result.projectedAngularVelocity, true);
      const appliedAngularSpeed = vectorMagnitude(body.angvel());
      assert.ok(
        appliedAngularSpeed <= MAX_ANGULAR_SPEED + EPSILON * 100,
        `applied Rapier angular speed ${appliedAngularSpeed} exceeded ${MAX_ANGULAR_SPEED}`,
      );
      world.step();
      peakHeight = Math.max(peakHeight, body.translation().y);
      const angularSpeed = vectorMagnitude(body.angvel());
      peakAngularSpeed = Math.max(peakAngularSpeed, angularSpeed);
      assert.ok([
        body.linvel().x,
        body.linvel().y,
        body.linvel().z,
        body.angvel().x,
        body.angvel().y,
        body.angvel().z,
      ].every(Number.isFinite));
    }

    assert.ok(peakHeight > 0.5, 'Rapier jump trace must move the body');
    assert.ok(peakAngularSpeed > 1, 'Rapier flip trace must rotate the body');
    return { peakHeight, peakAngularSpeed };
  } finally {
    freeTrackedWorld(world);
  }
}

function assertSetupFailureCleanup(): void {
  assert.throws(() => {
    const world = createTrackedWorld();
    try {
      world.createRigidBody(RAPIER.RigidBodyDesc.dynamic());
      throw new Error('synthetic jump setup assertion failure');
    } finally {
      freeTrackedWorld(world);
    }
  }, /synthetic jump setup assertion failure/);
}

async function main(): Promise<void> {
  await initPhysics();
  runFirstJumpAndHoldCases();
  runSecondJumpBoundaryCases();
  const flip = runFlipCases();
  runGroundResetAndSynchronizationCases();
  runAirAxisCases();
  const airRamp = runAirRampCases();
  runIntegratedPlannerCase();
  const groundingLifecycle = runRealGroundingLifecycle();
  const rapier = runRapierSmoke();
  assertSetupFailureCleanup();
  assert.equal(
    disposalTracker.freed,
    disposalTracker.created,
    'every jump-harness Rapier world must be freed',
  );

  console.log('=== JUMP / FLIP / AIR HARNESS: PASS ===');
  console.log(`flipAngular=${flip.activeAngularSpeed.toFixed(5)}rad/s`);
  console.log(
    `airSpinUp roll=${airRamp.rollSteps} steps yaw=${airRamp.yawSteps} steps`,
  );
  console.log(
    `groundingResidual=${groundingLifecycle.residualSupportSteps} steps airborneAt=${groundingLifecycle.airborneStep}`,
  );
  console.log(`rapierPeakY=${rapier.peakHeight.toFixed(5)}m peakAngular=${rapier.peakAngularSpeed.toFixed(5)}rad/s`);
  console.log(`cleanup=${disposalTracker.freed}/${disposalTracker.created} worlds`);
}

main().catch((error: unknown) => {
  console.error('=== JUMP / FLIP / AIR HARNESS: FAIL ===');
  console.error(error);
  process.exitCode = 1;
});
