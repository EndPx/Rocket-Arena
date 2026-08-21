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
  evaluateSteeringCurvatureCurve,
  planCarControllerCommand,
  type CarControllerFiniteState,
  type CarControllerObservation,
  type CarControllerPlanningContext,
  type ControllerQuaternion,
  type ControllerSurfaceBasis,
  type ControllerVector3,
} from './car-controller.js';
import { createSurfaceRelativeBasis } from './grounding.js';
import { initPhysics } from './world.js';

const EPSILON = 1e-9;
const IDENTITY: ControllerQuaternion = { x: 0, y: 0, z: 0, w: 1 };
const FLAT_BASIS: ControllerSurfaceBasis = {
  normal: { x: 0, y: 1, z: 0 },
  forward: { x: 0, y: 0, z: 1 },
  right: { x: 1, y: 0, z: 0 },
};
const TILTED_BASIS: ControllerSurfaceBasis = {
  normal: { x: 0, y: Math.SQRT1_2, z: Math.SQRT1_2 },
  forward: { x: 0, y: -Math.SQRT1_2, z: Math.SQRT1_2 },
  right: { x: 1, y: 0, z: 0 },
};
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

function tuningWithOverrides(
  overrides: ReadonlyMap<string, number | StructuredCurve>,
): Pick<TuningRegistrySnapshot, 'get'> {
  return {
    get(id: string): TuningEntry | undefined {
      const entry = DEFAULT_TUNING_REGISTRY_SNAPSHOT.get(id);
      const replacement = overrides.get(id);
      if (entry === undefined || replacement === undefined) return entry;
      if (entry.kind === 'scalar' && typeof replacement === 'number') {
        return { ...entry, value: replacement };
      }
      if (entry.kind === 'curve' && typeof replacement !== 'number') {
        return { ...entry, value: replacement };
      }
      return entry;
    },
  };
}

function tuningWithThrottleCurve(
  curve: StructuredCurve,
): Pick<TuningRegistrySnapshot, 'get'> {
  return tuningWithOverrides(new Map([[TUNING_IDS.car.throttle.accelerationCurve, curve]]));
}

function observation(
  linearVelocity: ControllerVector3 = { x: 0, y: 0, z: 0 },
  grounded = true,
  rotation: ControllerQuaternion = IDENTITY,
  angularVelocity: ControllerVector3 = { x: 0, y: 0, z: 0 },
  surfaceBasis: ControllerSurfaceBasis | null = null,
): CarControllerObservation {
  return { linearVelocity, angularVelocity, grounded, rotation, surfaceBasis };
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

function vectorDot(left: ControllerVector3, right: ControllerVector3): number {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

function vectorScale(vector: ControllerVector3, scalar: number): ControllerVector3 {
  return { x: vector.x * scalar, y: vector.y * scalar, z: vector.z * scalar };
}

function vectorAdd(left: ControllerVector3, right: ControllerVector3): ControllerVector3 {
  return { x: left.x + right.x, y: left.y + right.y, z: left.z + right.z };
}

function rotateByQuaternion(
  rotation: ControllerQuaternion,
  vector: ControllerVector3,
): ControllerVector3 {
  const tx = 2 * (rotation.y * vector.z - rotation.z * vector.y);
  const ty = 2 * (rotation.z * vector.x - rotation.x * vector.z);
  const tz = 2 * (rotation.x * vector.y - rotation.y * vector.x);
  return {
    x: vector.x + rotation.w * tx + (rotation.y * tz - rotation.z * ty),
    y: vector.y + rotation.w * ty + (rotation.z * tx - rotation.x * tz),
    z: vector.z + rotation.w * tz + (rotation.x * ty - rotation.y * tx),
  };
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
  // Rocket League's throttle curve: 16 m/s^2 from rest, 1.6 m/s^2 at 14 m/s,
  // nothing at the 14.1 m/s ceiling. Midpoints pin the interpolation.
  assertApproximately(evaluateNonIncreasingThrottleCurve(curve, 0), 16, 'curve at 0m/s');
  assertApproximately(evaluateNonIncreasingThrottleCurve(curve, 7), 8.8, 'curve interpolation');
  assertApproximately(evaluateNonIncreasingThrottleCurve(curve, 14), 1.6, 'curve near target');
  assertApproximately(evaluateNonIncreasingThrottleCurve(curve, 14.05), 0.8, 'curve interpolation 2');
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
    evaluateNonIncreasingThrottleCurve(curve, 5),
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
      pitch: -1,
      yaw: 0.75,
      roll: -0.5,
      jumpHeld: true,
      jumpSequence: 99,
      cameraToggleSequence: 42,
    }),
    observation(),
  );
  assert.deepEqual(
    ignoredControls.projectedVelocity,
    half.projectedVelocity,
    'Wave 16 controls must not affect Wave 15 planning',
  );
}

function runGroundedSteeringCases(): {
  normalResidual: number;
  powerslideResidual: number;
  powerslideYaw: number;
} {
  const curvatureCurve = getCurveTuningValue(
    DEFAULT_TUNING_REGISTRY_SNAPSHOT,
    TUNING_IDS.car.steering.curvatureCurve,
  );
  assertApproximately(
    evaluateSteeringCurvatureCurve(curvatureCurve, 0),
    0.18,
    'steering curve at zero',
  );
  assertApproximately(
    evaluateSteeringCurvatureCurve(curvatureCurve, 2.5),
    0.16,
    'steering curve interpolation',
  );
  assertApproximately(
    evaluateSteeringCurvatureCurve(curvatureCurve, 5),
    0.14,
    'steering curve at 5m/s',
  );
  assertApproximately(
    evaluateSteeringCurvatureCurve(curvatureCurve, 14.1),
    0.08,
    'steering curve at throttle target',
  );
  assertApproximately(
    evaluateSteeringCurvatureCurve(curvatureCurve, 30),
    0.04,
    'steering curve high clamp',
  );
  assert.throws(
    () => evaluateSteeringCurvatureCurve({
      outputOrder: 'non-increasing',
      samples: [{ input: 0, output: 0.6 }, { input: 23, output: 0.04 }],
    }, 5),
    /Steering curve/,
  );

  assert.throws(
    () => evaluateSteeringCurvatureCurve({
      outputOrder: 'non-increasing',
      samples: [{ input: 0, output: 0 }, { input: 23, output: 0 }],
    }, 5),
    /Steering curve/,
  );

  const invalidCurves: readonly (readonly [string, StructuredCurve])[] = [
    ['incomplete domain', {
      outputOrder: 'non-increasing',
      samples: [{ input: 0, output: 0.3 }, { input: 10, output: 0.1 }],
    }],
    ['all-zero output', {
      outputOrder: 'non-increasing',
      samples: [{ input: 0, output: 0 }, { input: 23, output: 0 }],
    }],
    ['zero terminal output', {
      outputOrder: 'non-increasing',
      samples: [{ input: 0, output: 0.2 }, { input: 10, output: 0.1 }, { input: 23, output: 0 }],
    }],
  ];
  for (const [label, invalidCurve] of invalidCurves) {
    const curveFallback = plan(
      command({ steer: 1 }),
      observation({ x: 0, y: 0, z: 5 }, true, IDENTITY, { x: 0, y: 0, z: 0 }, FLAT_BASIS),
      {
        tuning: tuningWithOverrides(new Map([
          [TUNING_IDS.car.steering.curvatureCurve, invalidCurve],
        ])),
      },
    );
    assertApproximately(
      curveFallback.groundedControl?.baseCurvature ?? Number.NaN,
      0.14,
      `${label} must use default steering curve`,
    );
    assert.equal(
      curveFallback.groundedControl?.gripRate,
      12,
      `${label} must fall back as one steering tuning group`,
    );
  }

  const invalidGripGroup = tuningWithOverrides(new Map<string, number | StructuredCurve>([
    [TUNING_IDS.car.steering.normalGripRate, 3],
    [TUNING_IDS.car.steering.powerslideGripRate, 5],
    [TUNING_IDS.car.steering.powerslideCurvatureMultiplier, 1],
  ]));
  const gripFallback = plan(
    command({ steer: 1 }),
    observation({ x: 2, y: 0, z: 10 }, true, IDENTITY, { x: 0, y: 0, z: 0 }, FLAT_BASIS),
    { tuning: invalidGripGroup },
  );
  assert.equal(gripFallback.groundedControl?.gripRate, 12, 'invalid grip group must fall back atomically');

  const tiltedVelocity = vectorAdd(
    vectorScale(TILTED_BASIS.forward, 10),
    vectorScale(TILTED_BASIS.right, 8),
  );
  const commonObservation = observation(
    tiltedVelocity,
    true,
    IDENTITY,
    { x: 0, y: 0, z: 0 },
    TILTED_BASIS,
  );
  const normal = plan(command({ steer: 1 }), commonObservation, { timestepSeconds: 1 / 60 });
  const powerslide = plan(
    command({ steer: 1, powerslideHeld: true }),
    commonObservation,
    { timestepSeconds: 1 / 60 },
  );
  assert.ok(normal.groundedControl !== null && powerslide.groundedControl !== null);
  assert.equal(normal.groundedControl.powerslideActive, false);
  assert.equal(powerslide.groundedControl.powerslideActive, true);
  assert.ok(powerslide.groundedControl.gripRate < normal.groundedControl.gripRate);
  assert.ok(powerslide.groundedControl.gripAlpha < normal.groundedControl.gripAlpha);
  assert.ok(
    magnitude(powerslide.lateralGripDeltaVelocity) < magnitude(normal.lateralGripDeltaVelocity),
    'powerslide must apply a smaller equal-state lateral correction',
  );

  const normalResidual = Math.abs(vectorDot(normal.projectedVelocity, TILTED_BASIS.right));
  const powerslideResidual = Math.abs(vectorDot(powerslide.projectedVelocity, TILTED_BASIS.right));
  assert.ok(normalResidual < powerslideResidual && powerslideResidual < 8);
  assertApproximately(normalResidual, 8 * Math.exp(-12 / 60), 'normal exponential grip');
  assertApproximately(powerslideResidual, 8 * Math.exp(-4 / 60), 'powerslide exponential grip');
  assert.ok(
    Math.sign(powerslide.groundedControl.commandedCurvature)
      === Math.sign(normal.groundedControl.commandedCurvature),
    'powerslide curvature must retain steering direction',
  );
  assertApproximately(
    powerslide.groundedControl.commandedCurvature,
    normal.groundedControl.commandedCurvature * 1.5,
    'powerslide curvature multiplier',
  );
  const expectedNormalYaw = evaluateSteeringCurvatureCurve(curvatureCurve, 10) * 10;
  assertApproximately(normal.groundedControl.targetYawRate, expectedNormalYaw, 'normal yaw target');
  assertApproximately(
    vectorDot(normal.projectedAngularVelocity, TILTED_BASIS.normal),
    expectedNormalYaw,
    'yaw follows support normal',
  );
  assertApproximately(
    magnitude(normal.projectedAngularVelocity),
    Math.abs(expectedNormalYaw),
    'steering angular output has no off-normal torque component',
  );

  for (const powerslideHeld of [false, true]) {
    for (const initialLateral of [-8, 8]) {
      let velocity = { x: initialLateral, y: 0, z: 10 };
      let previousMagnitude = Math.abs(initialLateral);
      for (let frame = 0; frame < 30; frame += 1) {
        const result = plan(
          command({ powerslideHeld }),
          observation(velocity, true, IDENTITY, { x: 0, y: 0, z: 0 }, FLAT_BASIS),
          { timestepSeconds: 1 / 60 },
        );
        const lateral = vectorDot(result.projectedVelocity, FLAT_BASIS.right);
        assert.ok(Math.abs(lateral) < previousMagnitude, 'lateral magnitude must decay every step');
        assert.equal(Math.sign(lateral), Math.sign(initialLateral), 'grip must not reverse lateral sign');
        previousMagnitude = Math.abs(lateral);
        velocity = { ...result.projectedVelocity };
      }
    }
  }

  for (const yaw of [-3, 3]) {
    const zeroSteer = plan(
      command({ steer: 0 }),
      observation(
        { x: 0, y: 0, z: 10 },
        true,
        IDENTITY,
        { x: 2, y: yaw, z: -1 },
        FLAT_BASIS,
      ),
    );
    assertApproximately(
      vectorDot(zeroSteer.projectedAngularVelocity, FLAT_BASIS.normal),
      0,
      'zero steer must decay support-normal yaw',
    );
    assertApproximately(zeroSteer.projectedAngularVelocity.x, 2, 'yaw decay preserves tangent x');
    assertApproximately(zeroSteer.projectedAngularVelocity.z, -1, 'yaw decay preserves tangent z');
  }

  const recoveredAngular = planCarControllerCommand(command({ steer: Number.NaN }), {
    observation: observation(
      { x: 0, y: 0, z: 10 },
      true,
      IDENTITY,
      { x: Number.NaN, y: 1, z: 2 },
      FLAT_BASIS,
    ),
    previousFiniteState: {
      rotation: IDENTITY,
      linearVelocity: { x: 0, y: 0, z: 10 },
      angularVelocity: { x: 0, y: 2, z: 0 },
    },
    availableBoost: 0,
    dragEnabled: false,
  });
  assert.equal(recoveredAngular.normalizedSteer, 0);
  assert.equal(recoveredAngular.groundedControl?.currentYawRate, 2);
  assertFiniteVector(recoveredAngular.projectedAngularVelocity, 'recovered angular output');

  const reverse = plan(
    command({ steer: 1 }),
    observation({ x: 0, y: 0, z: -10 }, true, IDENTITY, undefined, FLAT_BASIS),
  );
  assert.ok((reverse.groundedControl?.targetYawRate ?? 0) < 0, 'reverse speed must flip yaw sign');
  assert.ok(normal.groundedControl.targetYawRate > 0, 'forward speed must retain positive yaw sign');

  for (const gatedObservation of [
    observation({ x: 8, y: 0, z: 10 }, false, IDENTITY, { x: 0, y: 3, z: 0 }, FLAT_BASIS),
    observation({ x: 8, y: 0, z: 10 }, true, IDENTITY, { x: 0, y: 3, z: 0 }, null),
    observation(
      { x: 8, y: 0, z: 10 },
      true,
      IDENTITY,
      { x: 0, y: 3, z: 0 },
      { ...FLAT_BASIS, right: { x: -1, y: 0, z: 0 } },
    ),
    observation(
      { x: 0, y: 0, z: 10 },
      true,
      IDENTITY,
      { x: 0, y: 3, z: 0 },
      {
        normal: { x: 0, y: 1, z: 0 },
        forward: { x: 1, y: 0, z: 0 },
        right: { x: 0, y: 0, z: -1 },
      },
    ),
  ]) {
    const gated = plan(command({ steer: 1, powerslideHeld: true }), gatedObservation);
    assert.equal(gated.groundedControl, null);
    assert.deepEqual(gated.lateralGripDeltaVelocity, { x: 0, y: 0, z: 0 });
    assert.deepEqual(gated.angularDeltaVelocity, { x: 0, y: 0, z: 0 });
  }

  const atCapTurning = plan(
    command({ throttle: 1, boostHeld: true, steer: 1 }),
    observation({ x: 5, y: 0, z: 23 }, true, IDENTITY, undefined, FLAT_BASIS),
  );
  assert.ok(atCapTurning.propulsionProjectedForwardSpeed <= 23 + EPSILON);
  assert.ok(
    magnitude(atCapTurning.projectedVelocity)
      <= magnitude(atCapTurning.propulsionProjectedVelocity) + EPSILON,
    'grip and steering must not add linear speed at the propulsion cap',
  );
  const steeringOnly = plan(
    command({ steer: 1 }),
    observation({ x: 0, y: 0, z: 10 }, true, IDENTITY, undefined, FLAT_BASIS),
  );
  assertApproximately(
    magnitude(steeringOnly.lateralGripDeltaVelocity),
    0,
    'steering without lateral motion adds no linear grip delta',
  );
  assertApproximately(
    magnitude(steeringOnly.deltaVelocity),
    0,
    'steering produces no wheel-torque propulsion',
  );

  return {
    normalResidual,
    powerslideResidual,
    powerslideYaw: powerslide.groundedControl.targetYawRate,
  };
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
    world.createCollider(RAPIER.ColliderDesc.cuboid(0.42, 0.18, 0.59).setMass(150), body);
    let previousFiniteState: CarControllerFiniteState = {
      rotation: IDENTITY,
      linearVelocity: { x: 0, y: 0, z: 0 },
      angularVelocity: { x: 0, y: 0, z: 0 },
    };
    let peakProjection = 0;

    for (let frame = 0; frame < 240; frame += 1) {
      const rotation = body.rotation();
      const localForward = rotateByQuaternion(rotation, { x: 0, y: 0, z: 1 });
      const basis = createSurfaceRelativeBasis({ x: 0, y: 1, z: 0 }, localForward);
      const grounded = frame < 120;
      const input = command({
        throttle: 1,
        boostHeld: true,
        steer: 0.65,
        powerslideHeld: frame >= 60 && grounded,
      });
      const result = planCarControllerCommand(input, {
        observation: {
          rotation,
          linearVelocity: body.linvel(),
          angularVelocity: body.angvel(),
          grounded,
          surfaceBasis: grounded ? basis : null,
        },
        previousFiniteState,
        availableBoost: 100,
        timestepSeconds: timestep,
        dragEnabled: false,
      });
      body.setLinvel(result.projectedVelocity, true);
      body.setAngvel(result.projectedAngularVelocity, true);
      previousFiniteState = result.nextFiniteState;
      world.step();
      peakProjection = Math.max(
        peakProjection,
        Math.abs(result.propulsionProjectedForwardSpeed),
      );
      assertFiniteVector(result.projectedAngularVelocity, 'Rapier steering trace angular output');
      assert.ok(
        Math.abs(result.propulsionProjectedForwardSpeed) <= 23 + EPSILON,
        'Rapier turning trace must respect the 23m/s propulsion projection',
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
  const steering = runGroundedSteeringCases();
  const peakProjection = runRapierTrace();
  assertSetupFailureCleanup();
  assert.equal(
    disposalTracker.freed,
    disposalTracker.created,
    'every controller-harness Rapier world must be freed',
  );
  console.log('=== CAR CONTROLLER HARNESS: PASS ===');
  console.log(`boost projection peak=${peakProjection.toFixed(5)}m/s`);
  console.log(`grip residual normal=${steering.normalResidual.toFixed(5)} powerslide=${steering.powerslideResidual.toFixed(5)}m/s`);
  console.log(`powerslide yaw=${steering.powerslideYaw.toFixed(5)}rad/s`);
  console.log(`cleanup=${disposalTracker.freed}/${disposalTracker.created} worlds`);
}

main().catch((error: unknown) => {
  console.error('=== CAR CONTROLLER HARNESS: FAIL ===');
  console.error(error);
  process.exitCode = 1;
});
