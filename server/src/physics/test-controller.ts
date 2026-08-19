import assert from 'node:assert/strict';
import RAPIER from '@dimforge/rapier3d-compat';
import {
  DEFAULT_TUNING_REGISTRY_SNAPSHOT,
  INPUT_PROTOCOL_VERSION,
  TUNING_IDS,
  getCurveTuningValue,
  getScalarTuningValue,
  type InputCommandV2,
  type StructuredCurve,
  type TuningEntry,
  type TuningRegistrySnapshot,
} from '@rocket-arena/shared';
import {
  evaluateNonIncreasingThrottleCurve,
  planCarControllerCommand,
  type CarControllerObservation,
  type CarControllerPlanningContext,
  type ControllerQuaternion,
  type ControllerVector3,
} from './car-controller.js';
import { initPhysics } from './world.js';

const EPSILON = 1e-9;
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

function assertApproximately(actual: number, expected: number, label: string): void {
  assert.ok(
    Math.abs(actual - expected) <= EPSILON,
    `${label}: expected ${expected}, received ${actual}`,
  );
}

function assertFiniteVector(vector: ControllerVector3, label: string): void {
  assert.ok([vector.x, vector.y, vector.z].every(Number.isFinite), `${label} must be finite`);
}

function command(patch: Partial<InputCommandV2>): Readonly<InputCommandV2> {
  return Object.freeze({ ...NEUTRAL, ...patch });
}

function tuningWithThrottleCurve(
  curve: StructuredCurve,
): Pick<TuningRegistrySnapshot, 'get'> {
  return {
    get(id: string): TuningEntry | undefined {
      const entry = DEFAULT_TUNING_REGISTRY_SNAPSHOT.get(id);
      if (id !== TUNING_IDS.car.throttle.accelerationCurve || entry?.kind !== 'curve') {
        return entry;
      }
      return { ...entry, value: curve };
    },
  };
}

function observation(
  linearVelocity: ControllerVector3 = { x: 0, y: 0, z: 0 },
  grounded = true,
  rotation: ControllerQuaternion = IDENTITY,
): CarControllerObservation {
  return { linearVelocity, grounded, rotation };
}

function plan(
  input: Readonly<InputCommandV2>,
  observed: CarControllerObservation,
  patch: Partial<CarControllerPlanningContext> = {},
) {
  return planCarControllerCommand(input, {
    observation: observed,
    availableBoost: 100,
    dragEnabled: false,
    ...patch,
  });
}

function magnitude(vector: ControllerVector3): number {
  return Math.hypot(vector.x, vector.y, vector.z);
}

function createTrackedWorld(): RAPIER.World {
  disposalTracker.created += 1;
  return new RAPIER.World({ x: 0, y: 0, z: 0 });
}

function freeTrackedWorld(world: RAPIER.World): void {
  world.free();
  disposalTracker.freed += 1;
}

function runPurePlanningCases(): void {
  const curve = getCurveTuningValue(
    DEFAULT_TUNING_REGISTRY_SNAPSHOT,
    TUNING_IDS.car.throttle.accelerationCurve,
  );
  assert.equal(curve.outputOrder, 'non-increasing');
  assertApproximately(evaluateNonIncreasingThrottleCurve(curve, 0), 10, 'curve at 0m/s');
  assertApproximately(evaluateNonIncreasingThrottleCurve(curve, 2.5), 9, 'curve interpolation');
  assertApproximately(evaluateNonIncreasingThrottleCurve(curve, 7.5), 6, 'curve interpolation 2');
  assertApproximately(evaluateNonIncreasingThrottleCurve(curve, 14.1), 0, 'curve target');
  assertApproximately(evaluateNonIncreasingThrottleCurve(curve, 30), 0, 'curve high clamp');
  assert.throws(
    () => evaluateNonIncreasingThrottleCurve({
      outputOrder: 'non-increasing',
      samples: [{ input: 0, output: 1 }, { input: 1, output: 2 }],
    }, 0.5),
    /non-increasing/,
  );
  const zeroBelowTargetCurve: StructuredCurve = {
    outputOrder: 'non-increasing',
    samples: [{ input: 0, output: 0 }, { input: 14.1, output: 0 }],
  };
  const fallbackCurvePlan = plan(
    command({ throttle: 1 }),
    observation({ x: 0, y: 0, z: 5 }),
    { tuning: tuningWithThrottleCurve(zeroBelowTargetCurve) },
  );
  assertApproximately(
    fallbackCurvePlan.throttleAcceleration.z,
    8,
    'zero-output sub-target curve must fall back to the validated default',
  );

  const full = plan(command({ throttle: 1 }), observation());
  const half = plan(command({ throttle: 0.5 }), observation());
  assert.ok(full.throttleAcceleration.z > 0, 'grounded positive throttle must accelerate locally forward');
  assertApproximately(
    half.throttleAcceleration.z,
    full.throttleAcceleration.z / 2,
    'normalized throttle scaling',
  );
  const malformed = plan(
    command({ throttle: Number.NaN }),
    observation(),
  );
  assert.equal(malformed.normalizedThrottle, 0, 'non-finite typed input must become neutral');
  assert.deepEqual(malformed.throttleAcceleration, { x: 0, y: 0, z: 0 });

  for (const speed of [0, 5, 10, 14.099]) {
    const result = plan(command({ throttle: 1 }), observation({ x: 0, y: 0, z: speed }));
    assert.ok(result.throttleAcceleration.z > 0, `throttle must be positive below target at ${speed}`);
    assertFiniteVector(result.throttleAcceleration, `throttle at ${speed}`);
  }
  for (const speed of [14.1, 18, 23]) {
    const result = plan(command({ throttle: 1 }), observation({ x: 0, y: 0, z: speed }));
    assert.deepEqual(
      result.throttleAcceleration,
      { x: 0, y: 0, z: 0 },
      `positive throttle must stop at/above target (${speed})`,
    );
  }
  assert.deepEqual(
    plan(command({ throttle: 1 }), observation({ x: 0, y: 0, z: 0 }, false))
      .throttleAcceleration,
    { x: 0, y: 0, z: 0 },
    'task 5.2 throttle must not propel an airborne car',
  );

  const boostMagnitude = getScalarTuningValue(
    DEFAULT_TUNING_REGISTRY_SNAPSHOT,
    TUNING_IDS.car.boost.acceleration,
  );
  const groundBoost = plan(command({ boostHeld: true }), observation());
  assert.equal(groundBoost.boostActuated, true);
  assertApproximately(magnitude(groundBoost.boostAcceleration), boostMagnitude, 'ground boost');
  const pitchNinety: ControllerQuaternion = {
    x: -Math.SQRT1_2,
    y: 0,
    z: 0,
    w: Math.SQRT1_2,
  };
  const airBoost = plan(
    command({ boostHeld: true }),
    observation({ x: 0, y: 0, z: 0 }, false, pitchNinety),
  );
  assertApproximately(magnitude(airBoost.boostAcceleration), 9.91666, 'air boost magnitude');
  assertApproximately(airBoost.boostAcceleration.y, 9.91666, 'air boost follows local forward');
  assertApproximately(airBoost.boostAcceleration.x, 0, 'air boost x');
  assertApproximately(airBoost.boostAcceleration.z, 0, 'air boost z');
  const unavailable = plan(
    command({ boostHeld: true }),
    observation(),
    { availableBoost: 0 },
  );
  assert.equal(unavailable.boostActuated, false);
  assert.deepEqual(unavailable.boostAcceleration, { x: 0, y: 0, z: 0 });

  const authoritativeInventory = Object.freeze({ availableBoost: 37.25 });
  plan(command({ boostHeld: true }), observation(), authoritativeInventory);
  assert.equal(authoritativeInventory.availableBoost, 37.25, 'planner must not mutate boost inventory');

  const capped = plan(
    command({ throttle: 1, boostHeld: true }),
    observation({ x: 2, y: 3, z: 22.99 }),
    { timestepSeconds: 1 },
  );
  assertApproximately(capped.propulsionProjectedForwardSpeed, 23, 'strict propulsion projection');
  assertApproximately(capped.propulsionProjectedVelocity.x, 2, 'cap preserves lateral velocity');
  assertApproximately(capped.propulsionProjectedVelocity.y, 3, 'cap preserves vertical velocity');
  assertApproximately(magnitude(capped.boostAcceleration), 9.91666, 'requested capped boost remains exact');
  const alreadyOverCap = plan(
    command({ throttle: 1, boostHeld: true }),
    observation({ x: 0, y: 0, z: 24 }),
  );
  assert.equal(alreadyOverCap.appliedPropulsionDeltaVelocity.z, 0);
  assert.equal(alreadyOverCap.propulsionProjectedForwardSpeed, 24);
  const overCapBraking = plan(
    command({ throttle: -1 }),
    observation({ x: 0, y: 0, z: 24 }),
  );
  assert.ok(
    overCapBraking.propulsionProjectedForwardSpeed < 24,
    'above-cap braking may reduce speed without injecting a cap impulse',
  );

  const dragged = planCarControllerCommand(NEUTRAL, {
    observation: observation({ x: 3, y: -4, z: 12 }),
    availableBoost: 0,
    timestepSeconds: 1 / 60,
  });
  assert.ok(
    dragged.dragAcceleration.x * 3
      + dragged.dragAcceleration.y * -4
      + dragged.dragAcceleration.z * 12 < 0,
    'drag must oppose motion',
  );
  assertFiniteVector(dragged.dragAcceleration, 'drag acceleration');
  const longDrag = planCarControllerCommand(NEUTRAL, {
    observation: observation({ x: 1, y: 2, z: 3 }),
    availableBoost: 0,
    timestepSeconds: 1_000,
  });
  assert.deepEqual(longDrag.projectedVelocity, { x: 0, y: 0, z: 0 }, 'drag cannot reverse motion');

  const forwardToReverse = planCarControllerCommand(command({ throttle: -1 }), {
    observation: observation({ x: 0, y: 0, z: 0.01 }),
    availableBoost: 0,
    timestepSeconds: 1 / 60,
  });
  assert.ok(
    forwardToReverse.propulsionProjectedForwardSpeed < 0,
    'reverse throttle fixture must cross through zero',
  );
  assert.ok(
    forwardToReverse.dragAcceleration.z * 0.01 < 0,
    'drag must oppose authoritative forward motion through a propulsion reversal',
  );
  const reverseToForward = planCarControllerCommand(command({ throttle: 1 }), {
    observation: observation({ x: 0, y: 0, z: -0.01 }),
    availableBoost: 0,
    timestepSeconds: 1 / 60,
  });
  assert.ok(
    reverseToForward.propulsionProjectedForwardSpeed > 0,
    'forward throttle fixture must cross through zero',
  );
  assert.ok(
    reverseToForward.dragAcceleration.z * -0.01 < 0,
    'drag must oppose authoritative reverse motion through a propulsion reversal',
  );

  const recovered = planCarControllerCommand(command({ throttle: 1 }), {
    observation: observation(
      { x: Number.NaN, y: 8, z: 9 },
      true,
      { x: 0, y: 0, z: 0, w: Number.NaN },
    ),
    previousFiniteState: {
      rotation: IDENTITY,
      linearVelocity: { x: 1, y: 2, z: 3 },
    },
    availableBoost: 0,
    dragEnabled: false,
  });
  assert.equal(recovered.forwardSpeed, 3);
  assertFiniteVector(recovered.projectedVelocity, 'finite-state recovery');
  assert.ok(recovered.nextFiniteState.linearVelocity.z > 3);

  const ignoredControls = plan(
    command({
      throttle: 0.5,
      steer: 1,
      pitch: -1,
      yaw: 0.75,
      roll: -0.5,
      jumpHeld: true,
      jumpSequence: 99,
      powerslideHeld: true,
      cameraToggleSequence: 42,
    }),
    observation(),
  );
  assert.deepEqual(
    ignoredControls.projectedVelocity,
    half.projectedVelocity,
    'later-wave controls must not affect task 5.2 planning',
  );
}

function runRapierTrace(): number {
  const world = createTrackedWorld();
  try {
    const timestep = getScalarTuningValue(
      DEFAULT_TUNING_REGISTRY_SNAPSHOT,
      TUNING_IDS.physics.fixedStepSeconds,
    );
    world.timestep = timestep;
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic());
    const input = command({ throttle: 1, boostHeld: true });
    let previousFiniteState = { rotation: IDENTITY, linearVelocity: { x: 0, y: 0, z: 0 } };
    let peakProjection = 0;

    for (let frame = 0; frame < 240; frame += 1) {
      const result = planCarControllerCommand(input, {
        observation: {
          rotation: body.rotation(),
          linearVelocity: body.linvel(),
          grounded: frame < 120,
        },
        previousFiniteState,
        availableBoost: 100,
        timestepSeconds: timestep,
        dragEnabled: false,
      });
      body.setLinvel(result.projectedVelocity, true);
      previousFiniteState = result.nextFiniteState;
      world.step();
      peakProjection = Math.max(peakProjection, body.linvel().z);
      assert.ok(
        result.propulsionProjectedForwardSpeed <= 23 + EPSILON,
        'Rapier trace must respect the 23m/s propulsion projection',
      );
    }

    assert.ok(peakProjection > 14.1, 'boost trace must exceed the throttle target');
    assert.ok(peakProjection <= 23 + EPSILON, 'boost trace must never exceed the propulsion cap');
    return peakProjection;
  } finally {
    freeTrackedWorld(world);
  }
}

function assertSetupFailureCleanup(): void {
  assert.throws(() => {
    const world = createTrackedWorld();
    try {
      world.createRigidBody(RAPIER.RigidBodyDesc.dynamic());
      throw new Error('synthetic controller setup assertion failure');
    } finally {
      freeTrackedWorld(world);
    }
  }, /synthetic controller setup assertion failure/);
}

async function main(): Promise<void> {
  await initPhysics();
  runPurePlanningCases();
  const peakProjection = runRapierTrace();
  assertSetupFailureCleanup();
  assert.equal(
    disposalTracker.freed,
    disposalTracker.created,
    'every controller-harness Rapier world must be freed',
  );
  console.log('=== CAR CONTROLLER HARNESS: PASS ===');
  console.log(`boost projection peak=${peakProjection.toFixed(5)}m/s`);
  console.log(`cleanup=${disposalTracker.freed}/${disposalTracker.created} worlds`);
}

main().catch((error: unknown) => {
  console.error('=== CAR CONTROLLER HARNESS: FAIL ===');
  console.error(error);
  process.exitCode = 1;
});
