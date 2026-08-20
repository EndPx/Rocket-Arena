import assert from 'node:assert/strict';
import test from 'node:test';
import RAPIER from '@dimforge/rapier3d-compat';
import {
  ARENA_COLLISION_GEOMETRY,
  DEFAULT_TUNING_REGISTRY_SNAPSHOT,
  INPUT_PROTOCOL_VERSION,
  MATCH_RULES,
  PHYSICS,
  ROOM_POLICIES,
  TUNING_IDS,
  getScalarTuningValue,
  type InputCommandV2,
  type RoomPinnedTuningSnapshot,
  type RosterEntry,
  type StructuredCurve,
  type TuningEntry,
  type TuningRegistrySnapshot,
} from '@rocket-arena/shared';
import {
  BALL_LINEAR_SPEED_TOLERANCE,
  createBall,
  recoverBallAfterStep,
  recoverBallBeforeStep,
} from './ball.js';
import {
  CAR_LINEAR_SPEED_TOLERANCE,
  createCarBody,
  recoverCarBodyAfterStep,
  recoverCarBodyBeforeStep,
} from './car-body.js';
import {
  createCarJumpAirState,
  planCarControllerCommand,
  type CarControllerFiniteState,
  type CarControllerObservation,
  type CarControllerPlan,
  type ControllerVector3,
} from './car-controller.js';
import type { FiniteRigidBodyState } from './finite-state.js';
import { createWorld, initPhysics } from './world.js';
import {
  AuthoritativeRoomCore,
  type AuthoritativeRoomProjection,
} from '../rooms/authoritative-room-core.js';
import {
  initializeAuthoritativeRapierWorld,
  type AuthoritativeRapierCar,
  type AuthoritativeRapierRoomWorldBundle,
} from '../rooms/rapier-room-world.js';

interface SeededRandom {
  readonly seed: string;
  next(): number;
  integer(minInclusive: number, maxInclusive: number): number;
  boolean(probability?: number): boolean;
  pick<T>(values: readonly T[]): T;
}

interface GeneratedCase<T> {
  readonly seed: string;
  readonly index: number;
  readonly value: T;
}

type CaseGenerator<T> = (random: SeededRandom, index: number) => T;

interface GeneratedCasesModule {
  generateCases<T>(options: {
    readonly seed: string | number;
    readonly count: number;
    readonly generate: CaseGenerator<T>;
  }): readonly GeneratedCase<T>[];
  replayCase<T>(
    seed: string | number,
    index: number,
    generate: CaseGenerator<T>,
  ): GeneratedCase<T>;
  assertGeneratedCases<T>(
    cases: readonly GeneratedCase<T>[],
    assertion: (value: T, generatedCase: GeneratedCase<T>) => void,
  ): void;
}

// Shared generated-case support is outside server/tsconfig.json's rootDir.
const generatedCasesModuleUrl = new URL(
  '../../../shared/tests/support/generated-cases.ts',
  import.meta.url,
).href;
const {
  assertGeneratedCases,
  generateCases,
  replayCase,
} = await import(generatedCasesModuleUrl) as unknown as GeneratedCasesModule;

const RECORDED_SEED = 'rocket-arena-property-10-finite-bounds-v1';
const GENERATED_CASE_COUNT = 100;
const REPLAY_CASE_INDEX = 67;
const FIXED_STEP_MS = PHYSICS.TIMESTEP * 1_000;
const EPSILON = 1e-5;
const CAR_LINEAR_CAP = 23.05;
const CAR_ANGULAR_CAP = 5.5;
const BALL_LINEAR_CAP = 60.05;
const BALL_ANGULAR_CAP = 6;
const NON_FINITE_VALUES = Object.freeze([
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
] as const);

const INVALID_SCALAR_IDS = Object.freeze([
  TUNING_IDS.physics.fixedStepSeconds,
  TUNING_IDS.physics.gravityY,
  TUNING_IDS.car.collider.length,
  TUNING_IDS.car.collider.width,
  TUNING_IDS.car.collider.height,
  TUNING_IDS.car.mass,
  TUNING_IDS.car.maxLinearSpeed,
  TUNING_IDS.car.maxAngularSpeed,
  TUNING_IDS.car.throttle.targetSpeed,
  TUNING_IDS.car.boost.acceleration,
  TUNING_IDS.car.steering.normalGripRate,
  TUNING_IDS.car.steering.powerslideGripRate,
  TUNING_IDS.car.steering.powerslideCurvatureMultiplier,
  TUNING_IDS.car.aerodynamicDragCoefficient,
  TUNING_IDS.car.jump.holdForce,
  TUNING_IDS.car.jump.holdDuration,
  TUNING_IDS.car.jump.secondJumpWindow,
  TUNING_IDS.car.jump.flipActuationWindow,
  TUNING_IDS.car.jump.directionalDeadzone,
  TUNING_IDS.ball.radius,
  TUNING_IDS.ball.mass,
  TUNING_IDS.ball.restitution,
  TUNING_IDS.ball.linearDamping,
  TUNING_IDS.ball.maxLinearSpeed,
  TUNING_IDS.ball.maxAngularSpeed,
] as const);

const CONTROLLER_AXIS_FIELDS = Object.freeze([
  'throttle',
  'steer',
  'pitch',
  'yaw',
  'roll',
] as const);

const CONTROLLER_OBSERVATION_FIELDS = Object.freeze([
  'rotation',
  'linearVelocity',
  'angularVelocity',
  'surfaceBasis',
] as const);

type ControllerAxisField = typeof CONTROLLER_AXIS_FIELDS[number];
type ControllerObservationField = typeof CONTROLLER_OBSERVATION_FIELDS[number];

interface TuningOverride {
  readonly id: string;
  readonly value: number | StructuredCurve;
}

interface GeneratedFiniteBoundsCase {
  readonly caseIndex: number;
  readonly mode: 'finite' | 'non-finite';
  readonly nonFiniteOrdinal: number | null;
  readonly malformedInputAxis: ControllerAxisField | null;
  readonly malformedObservationField: ControllerObservationField | null;
  readonly invalidScalarTuningId: string | null;
  readonly input: Readonly<InputCommandV2>;
  readonly observation: Readonly<CarControllerObservation>;
  readonly previousFiniteState?: Readonly<CarControllerFiniteState>;
  readonly availableBoost: number;
  readonly timestepSeconds: number;
  readonly fixedStepIndex: number;
  readonly tuningOverrides: readonly TuningOverride[];
  readonly bodyInvalidValues: readonly [number, number, number, number];
  readonly carLinearOverCap: Readonly<ControllerVector3>;
  readonly carAngularOverCap: Readonly<ControllerVector3>;
  readonly ballLinearOverCap: Readonly<ControllerVector3>;
  readonly ballAngularOverCap: Readonly<ControllerVector3>;
}

interface FiniteBoundsTrace {
  readonly plan: Readonly<{
    forwardSpeed: number;
    propulsionProjectedForwardSpeed: number;
    projectedSpeed: number;
    projectedAngularSpeed: number;
    boostActuated: boolean;
    jumpEvent: string | null;
  }>;
  readonly car: Readonly<{
    linearSpeed: number;
    angularSpeed: number;
    recoveredFields: readonly string[];
  }>;
  readonly ball: Readonly<{
    linearSpeed: number;
    angularSpeed: number;
    recoveredFields: readonly string[];
  }>;
  readonly cleanupCount: number;
}

type BodyField = keyof FiniteRigidBodyState;
type RecoverBody = (body: RAPIER.RigidBody) => FiniteRigidBodyState;

const BODY_FIELDS = Object.freeze([
  'translation',
  'rotation',
  'linearVelocity',
  'angularVelocity',
] as const satisfies readonly BodyField[]);

const FLAT_SURFACE_BASIS = Object.freeze({
  normal: Object.freeze({ x: 0, y: 1, z: 0 }),
  forward: Object.freeze({ x: 0, y: 0, z: 1 }),
  right: Object.freeze({ x: 1, y: 0, z: 0 }),
});

const ORACLE_IDENTITY_ROTATION = Object.freeze({ x: 0, y: 0, z: 0, w: 1 });
const ORACLE_ZERO_VECTOR = Object.freeze({ x: 0, y: 0, z: 0 });

const VALID_THROTTLE_CURVE: StructuredCurve = Object.freeze({
  outputOrder: 'non-increasing',
  samples: Object.freeze([
    Object.freeze({ input: 0, output: 10 }),
    Object.freeze({ input: 5, output: 8 }),
    Object.freeze({ input: 10, output: 4 }),
    Object.freeze({ input: 14.1, output: 0 }),
  ]),
});

const VALID_STEERING_CURVE: StructuredCurve = Object.freeze({
  outputOrder: 'non-increasing',
  samples: Object.freeze([
    Object.freeze({ input: 0, output: 0.18 }),
    Object.freeze({ input: 5, output: 0.14 }),
    Object.freeze({ input: 14.1, output: 0.08 }),
    Object.freeze({ input: 23, output: 0.04 }),
  ]),
});

const INVALID_CURVES = Object.freeze([
  Object.freeze({
    outputOrder: 'non-increasing' as const,
    samples: Object.freeze([]),
  }),
  Object.freeze({
    outputOrder: 'non-increasing' as const,
    samples: Object.freeze([
      Object.freeze({ input: 0, output: 1 }),
      Object.freeze({ input: 1, output: 2 }),
    ]),
  }),
  Object.freeze({
    outputOrder: 'non-increasing' as const,
    samples: Object.freeze([
      Object.freeze({ input: 0, output: 1 }),
      Object.freeze({ input: Number.NaN, output: 0 }),
    ]),
  }),
  Object.freeze({
    outputOrder: 'non-increasing' as const,
    samples: Object.freeze([
      Object.freeze({ input: 2, output: 1 }),
      Object.freeze({ input: 1, output: 0 }),
    ]),
  }),
] satisfies readonly StructuredCurve[]);

function finiteBetween(random: SeededRandom, minimum: number, maximum: number): number {
  return minimum + (maximum - minimum) * random.next();
}

function axisValue(random: SeededRandom): number {
  return finiteBetween(random, -2, 2);
}

function nonFiniteFor(index: number): number {
  return NON_FINITE_VALUES[index % NON_FINITE_VALUES.length]!;
}

function nonFiniteOrdinalFor(caseIndex: number): number | null {
  if (caseIndex % 5 === 0) return null;
  return caseIndex - Math.floor(caseIndex / 5) - 1;
}

function vectorAtMagnitude(
  random: SeededRandom,
  magnitude: number,
): Readonly<ControllerVector3> {
  let raw = {
    x: finiteBetween(random, -1, 1),
    y: finiteBetween(random, -1, 1),
    z: finiteBetween(random, -1, 1),
  };
  if (Math.hypot(raw.x, raw.y, raw.z) < 0.1) raw = { x: 1, y: -0.5, z: 0.25 };
  const length = Math.hypot(raw.x, raw.y, raw.z);
  return Object.freeze({
    x: raw.x / length * magnitude,
    y: raw.y / length * magnitude,
    z: raw.z / length * magnitude,
  });
}

function generatedInput(
  random: SeededRandom,
  caseIndex: number,
  nonFiniteOrdinal: number | null,
): Readonly<InputCommandV2> {
  const axes = [
    axisValue(random),
    axisValue(random),
    axisValue(random),
    axisValue(random),
    axisValue(random),
  ];
  if (nonFiniteOrdinal !== null) {
    axes[nonFiniteOrdinal % axes.length] = nonFiniteFor(caseIndex);
  }

  return Object.freeze({
    protocolVersion: INPUT_PROTOCOL_VERSION,
    throttle: axes[0]!,
    steer: axes[1]!,
    pitch: axes[2]!,
    yaw: axes[3]!,
    roll: axes[4]!,
    jumpHeld: random.boolean(),
    jumpSequence: nonFiniteOrdinal !== null && nonFiniteOrdinal % 4 === 0
      ? nonFiniteFor(caseIndex + 1)
      : random.integer(0, 500),
    boostHeld: random.boolean(),
    powerslideHeld: random.boolean(),
    cameraToggleSequence: nonFiniteOrdinal !== null && nonFiniteOrdinal % 4 === 1
      ? nonFiniteFor(caseIndex + 2)
      : random.integer(0, 500),
  });
}

function generatedObservation(
  random: SeededRandom,
  caseIndex: number,
  nonFiniteOrdinal: number | null,
): Readonly<CarControllerObservation> {
  const linearVelocity = {
    x: finiteBetween(random, -30, 30),
    y: finiteBetween(random, -12, 12),
    z: finiteBetween(random, -30, 30),
  };
  const angularVelocity = {
    x: finiteBetween(random, -8, 8),
    y: finiteBetween(random, -8, 8),
    z: finiteBetween(random, -8, 8),
  };
  const rotation = { x: 0, y: 0, z: 0, w: 1 };
  let surfaceBasis: CarControllerObservation['surfaceBasis'] = FLAT_SURFACE_BASIS;

  if (nonFiniteOrdinal !== null) {
    switch (nonFiniteOrdinal % CONTROLLER_OBSERVATION_FIELDS.length) {
      case 0:
        rotation.w = nonFiniteFor(caseIndex);
        break;
      case 1:
        linearVelocity.x = nonFiniteFor(caseIndex);
        break;
      case 2:
        angularVelocity.z = nonFiniteFor(caseIndex);
        break;
      default:
        surfaceBasis = {
          ...FLAT_SURFACE_BASIS,
          right: { x: nonFiniteFor(caseIndex), y: 0, z: 0 },
        };
        break;
    }
  }

  return Object.freeze({
    rotation: Object.freeze(rotation),
    linearVelocity: Object.freeze(linearVelocity),
    angularVelocity: Object.freeze(angularVelocity),
    grounded: caseIndex % 2 === 0,
    surfaceBasis,
  });
}

function generatedPreviousFiniteState(
  random: SeededRandom,
  caseIndex: number,
): Readonly<CarControllerFiniteState> | undefined {
  if (caseIndex % 3 === 0) return undefined;
  return Object.freeze({
    rotation: Object.freeze({ x: 0, y: 1, z: 0, w: 0 }),
    linearVelocity: Object.freeze({
      x: finiteBetween(random, -10, 10),
      y: finiteBetween(random, -5, 5),
      z: finiteBetween(random, -10, 10),
    }),
    angularVelocity: Object.freeze({
      x: finiteBetween(random, -4, 4),
      y: finiteBetween(random, -4, 4),
      z: finiteBetween(random, -4, 4),
    }),
  });
}

function generatedTuningOverrides(
  random: SeededRandom,
  caseIndex: number,
  nonFiniteOrdinal: number | null,
): readonly TuningOverride[] {
  if (nonFiniteOrdinal === null) {
    const finiteOverrides: readonly TuningOverride[] = [
      {
        id: TUNING_IDS.car.aerodynamicDragCoefficient,
        value: finiteBetween(random, 0, 0.1),
      },
      { id: TUNING_IDS.car.throttle.accelerationCurve, value: VALID_THROTTLE_CURVE },
      { id: TUNING_IDS.car.steering.curvatureCurve, value: VALID_STEERING_CURVE },
    ];
    return Object.freeze(finiteOverrides.map((entry) => Object.freeze(entry)));
  }

  const invalidCurve = INVALID_CURVES[nonFiniteOrdinal % INVALID_CURVES.length]!;
  return Object.freeze([
    Object.freeze({
      id: INVALID_SCALAR_IDS[nonFiniteOrdinal % INVALID_SCALAR_IDS.length]!,
      value: nonFiniteFor(caseIndex),
    }),
    Object.freeze({ id: TUNING_IDS.car.throttle.accelerationCurve, value: invalidCurve }),
    Object.freeze({ id: TUNING_IDS.car.steering.curvatureCurve, value: invalidCurve }),
  ]);
}

function generateFiniteBoundsCase(
  random: SeededRandom,
  caseIndex: number,
): GeneratedFiniteBoundsCase {
  const nonFiniteOrdinal = nonFiniteOrdinalFor(caseIndex);
  const finiteMode = nonFiniteOrdinal === null;
  return Object.freeze({
    caseIndex,
    mode: finiteMode ? 'finite' : 'non-finite',
    nonFiniteOrdinal,
    malformedInputAxis: finiteMode
      ? null
      : CONTROLLER_AXIS_FIELDS[nonFiniteOrdinal % CONTROLLER_AXIS_FIELDS.length]!,
    malformedObservationField: finiteMode
      ? null
      : CONTROLLER_OBSERVATION_FIELDS[
        nonFiniteOrdinal % CONTROLLER_OBSERVATION_FIELDS.length
      ]!,
    invalidScalarTuningId: finiteMode
      ? null
      : INVALID_SCALAR_IDS[nonFiniteOrdinal % INVALID_SCALAR_IDS.length]!,
    input: generatedInput(random, caseIndex, nonFiniteOrdinal),
    observation: generatedObservation(random, caseIndex, nonFiniteOrdinal),
    previousFiniteState: generatedPreviousFiniteState(random, caseIndex),
    availableBoost: finiteMode
      ? finiteBetween(random, 0, 100)
      : (nonFiniteOrdinal % 2 === 0
        ? nonFiniteFor(caseIndex + 1)
        : finiteBetween(random, -100, 100)),
    timestepSeconds: finiteMode
      ? PHYSICS.TIMESTEP
      : ([0, -1, Number.NaN, Number.POSITIVE_INFINITY] as const)[nonFiniteOrdinal % 4]!,
    fixedStepIndex: finiteMode
      ? caseIndex
      : (nonFiniteOrdinal % 6 === 0 ? Number.NaN : caseIndex),
    tuningOverrides: generatedTuningOverrides(random, caseIndex, nonFiniteOrdinal),
    bodyInvalidValues: Object.freeze([
      nonFiniteFor(caseIndex),
      nonFiniteFor(caseIndex + 1),
      nonFiniteFor(caseIndex + 2),
      nonFiniteFor(caseIndex + 3),
    ] as const),
    carLinearOverCap: vectorAtMagnitude(random, CAR_LINEAR_CAP * finiteBetween(random, 1.1, 4)),
    carAngularOverCap: vectorAtMagnitude(random, CAR_ANGULAR_CAP * finiteBetween(random, 1.1, 4)),
    ballLinearOverCap: vectorAtMagnitude(random, BALL_LINEAR_CAP * finiteBetween(random, 1.1, 4)),
    ballAngularOverCap: vectorAtMagnitude(random, BALL_ANGULAR_CAP * finiteBetween(random, 1.1, 4)),
  });
}

function tuningWithOverrides(
  overrides: readonly TuningOverride[],
): Pick<TuningRegistrySnapshot, 'get'> {
  const values = new Map(overrides.map(({ id, value }) => [id, value] as const));
  return {
    get(id: string): TuningEntry | undefined {
      const entry = DEFAULT_TUNING_REGISTRY_SNAPSHOT.get(id);
      if (entry === undefined || !values.has(id)) return entry;
      const replacement = values.get(id)!;
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

function magnitude(vector: ControllerVector3): number {
  return Math.hypot(vector.x, vector.y, vector.z);
}

function assertFiniteNumbers(
  value: unknown,
  path = 'value',
  visited: WeakSet<object> = new WeakSet(),
): void {
  if (typeof value === 'number') {
    assert.ok(Number.isFinite(value), `${path} must be finite, received ${value}`);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  if (visited.has(value)) return;
  visited.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      assertFiniteNumbers(entry, `${path}[${index}]`, visited);
    });
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    assertFiniteNumbers(entry, `${path}.${key}`, visited);
  }
}

function assertApproximately(actual: number, expected: number, label: string): void {
  assert.ok(
    Math.abs(actual - expected) <= EPSILON,
    `${label}: expected ${expected}, received ${actual}`,
  );
}

function assertDirectionPreserved(
  before: ControllerVector3,
  after: ControllerVector3,
  label: string,
): void {
  const beforeLength = magnitude(before);
  const afterLength = magnitude(after);
  assert.ok(beforeLength > 0 && afterLength > 0, `${label} vectors must be non-zero`);
  assertApproximately(after.x / afterLength, before.x / beforeLength, `${label}.x`);
  assertApproximately(after.y / afterLength, before.y / beforeLength, `${label}.y`);
  assertApproximately(after.z / afterLength, before.z / beforeLength, `${label}.z`);
}

function finiteBodyState(caseIndex: number, ordinal: number): FiniteRigidBodyState {
  const base = caseIndex * 10 + ordinal * 3;
  return {
    translation: { x: base + 1, y: ordinal + 1, z: -base - 2 },
    rotation: ordinal % 2 === 0
      ? { x: 0, y: 0, z: 0, w: 1 }
      : { x: 0, y: 1, z: 0, w: 0 },
    linearVelocity: { x: ordinal + 1, y: -ordinal - 2, z: ordinal + 3 },
    angularVelocity: { x: -ordinal - 1, y: ordinal + 2, z: ordinal + 1 },
  };
}

function applyBodyState(body: RAPIER.RigidBody, state: FiniteRigidBodyState): void {
  body.setTranslation(state.translation, true);
  body.setRotation(state.rotation, true);
  body.setLinvel(state.linearVelocity, true);
  body.setAngvel(state.angularVelocity, true);
}

function withInvalidField(
  state: FiniteRigidBodyState,
  field: BodyField,
  invalidValue: number,
): FiniteRigidBodyState {
  if (field === 'translation') {
    return { ...state, translation: { ...state.translation, x: invalidValue } };
  }
  if (field === 'rotation') {
    return { ...state, rotation: { ...state.rotation, w: invalidValue } };
  }
  if (field === 'linearVelocity') {
    return { ...state, linearVelocity: { ...state.linearVelocity, y: invalidValue } };
  }
  return { ...state, angularVelocity: { ...state.angularVelocity, z: invalidValue } };
}

function exercisePerFieldRecovery(
  body: RAPIER.RigidBody,
  recover: RecoverBody,
  generated: GeneratedFiniteBoundsCase,
  bodyOffset: number,
  label: string,
): readonly string[] {
  const baseline = finiteBodyState(generated.caseIndex, bodyOffset);
  applyBodyState(body, baseline);
  let previous = recover(body);
  assert.deepEqual(previous, baseline);

  const recoveredFields: string[] = [];
  BODY_FIELDS.forEach((field, fieldIndex) => {
    const finiteCandidate = finiteBodyState(
      generated.caseIndex,
      bodyOffset + fieldIndex + 1,
    );
    applyBodyState(
      body,
      withInvalidField(finiteCandidate, field, generated.bodyInvalidValues[fieldIndex]!),
    );
    const recovered = recover(body);
    assert.deepEqual(
      recovered[field],
      previous[field],
      `${label}.${field} must recover its own last finite value`,
    );
    for (const unaffected of BODY_FIELDS) {
      if (unaffected === field) continue;
      assert.deepEqual(
        recovered[unaffected],
        finiteCandidate[unaffected],
        `${label}.${unaffected} must survive ${field} recovery`,
      );
    }
    assertFiniteNumbers(recovered, `${label}.${field}.recovered`);
    previous = recovered;
    recoveredFields.push(field);
  });

  return Object.freeze(recoveredFields);
}

function bodyExposure(body: RAPIER.RigidBody): Readonly<Record<string, unknown>> {
  return Object.freeze({
    translation: body.translation(),
    rotation: body.rotation(),
    linearVelocity: body.linvel(),
    angularVelocity: body.angvel(),
  });
}

function assertControllerBounds(plan: Readonly<CarControllerPlan>): void {
  assertFiniteNumbers(plan, 'controllerPlan');
  const currentProjectionMagnitude = Math.abs(plan.forwardSpeed);
  const nextProjectionMagnitude = Math.abs(plan.propulsionProjectedForwardSpeed);
  assert.ok(
    nextProjectionMagnitude <= Math.max(23, currentProjectionMagnitude) + EPSILON,
    'propulsion may not increase local-forward magnitude beyond the 23 m/s cap',
  );
  if (currentProjectionMagnitude <= 23 + EPSILON) {
    assert.ok(
      nextProjectionMagnitude <= 23 + EPSILON,
      'in-cap propulsion must remain at or below 23 m/s',
    );
  }
  if (plan.jumpAirControl !== null && plan.groundedControl === null) {
    assert.ok(
      magnitude(plan.jumpAirControl.airAngularTarget) <= CAR_ANGULAR_CAP + EPSILON,
      'combined airborne angular target must remain at or below 5.5 rad/s',
    );
  }
}

function explicitlySanitizedInput(
  input: Readonly<InputCommandV2>,
): Readonly<InputCommandV2> {
  const finiteAxisOrZero = (value: number): number => Number.isFinite(value) ? value : 0;
  const finiteSequenceOrZero = (value: number): number => (
    Number.isSafeInteger(value) && value >= 0 ? value : 0
  );
  return Object.freeze({
    ...input,
    throttle: finiteAxisOrZero(input.throttle),
    steer: finiteAxisOrZero(input.steer),
    pitch: finiteAxisOrZero(input.pitch),
    yaw: finiteAxisOrZero(input.yaw),
    roll: finiteAxisOrZero(input.roll),
    jumpSequence: finiteSequenceOrZero(input.jumpSequence),
    cameraToggleSequence: finiteSequenceOrZero(input.cameraToggleSequence),
  });
}

function explicitlyRecoveredObservation(
  generated: GeneratedFiniteBoundsCase,
): Readonly<CarControllerObservation> {
  const malformedField = generated.malformedObservationField;
  return Object.freeze({
    rotation: malformedField === 'rotation'
      ? generated.previousFiniteState?.rotation ?? ORACLE_IDENTITY_ROTATION
      : generated.observation.rotation,
    linearVelocity: malformedField === 'linearVelocity'
      ? generated.previousFiniteState?.linearVelocity ?? ORACLE_ZERO_VECTOR
      : generated.observation.linearVelocity,
    angularVelocity: malformedField === 'angularVelocity'
      ? generated.previousFiniteState?.angularVelocity ?? ORACLE_ZERO_VECTOR
      : generated.observation.angularVelocity,
    grounded: generated.observation.grounded,
    surfaceBasis: malformedField === 'surfaceBasis'
      ? null
      : generated.observation.surfaceBasis,
  });
}

function assertExplicitControllerFallbacks(
  generated: GeneratedFiniteBoundsCase,
  tuning: Pick<TuningRegistrySnapshot, 'get'>,
  malformedPlan: Readonly<CarControllerPlan>,
): void {
  if (generated.mode !== 'non-finite') return;

  const commonContext = {
    availableBoost: generated.availableBoost,
    timestepSeconds: generated.timestepSeconds,
    jumpAir: {
      state: createCarJumpAirState(),
      fixedStepIndex: generated.fixedStepIndex,
    },
  } as const;

  const explicitInputPlan = planCarControllerCommand(
    explicitlySanitizedInput(generated.input),
    {
      ...commonContext,
      observation: generated.observation,
      previousFiniteState: generated.previousFiniteState,
      tuning,
    },
  );
  assert.deepEqual(
    malformedPlan,
    explicitInputPlan,
    `${generated.malformedInputAxis} must recover exactly to a zero input`,
  );

  const explicitObservationPlan = planCarControllerCommand(generated.input, {
    ...commonContext,
    observation: explicitlyRecoveredObservation(generated),
    tuning,
  });
  assert.deepEqual(
    malformedPlan,
    explicitObservationPlan,
    `${generated.malformedObservationField} must recover to its own previous value or default`,
  );

  const immutableDefaultTuningPlan = planCarControllerCommand(generated.input, {
    ...commonContext,
    observation: generated.observation,
    previousFiniteState: generated.previousFiniteState,
    tuning: DEFAULT_TUNING_REGISTRY_SNAPSHOT,
  });
  assert.deepEqual(
    malformedPlan,
    immutableDefaultTuningPlan,
    `${generated.invalidScalarTuningId} and malformed curves must use immutable defaults`,
  );
}

function exerciseFiniteBoundsCase(
  generated: GeneratedFiniteBoundsCase,
): FiniteBoundsTrace {
  const tuning = tuningWithOverrides(generated.tuningOverrides);
  const plan = planCarControllerCommand(generated.input, {
    observation: generated.observation,
    previousFiniteState: generated.previousFiniteState,
    availableBoost: generated.availableBoost,
    tuning,
    timestepSeconds: generated.timestepSeconds,
    jumpAir: {
      state: createCarJumpAirState(),
      fixedStepIndex: generated.fixedStepIndex,
    },
  });
  assertControllerBounds(plan);
  assertExplicitControllerFallbacks(generated, tuning, plan);

  const world = createWorld(tuning);
  let cleanupCount = 0;
  try {
    const car = createCarBody(
      world,
      { x: 0, y: 1, z: -2 },
      { x: 0, y: 0, z: 0, w: 1 },
      tuning,
    );
    const ball = createBall(world, { x: 0, y: 2, z: 2 }, tuning);

    const carRecoveredFields = exercisePerFieldRecovery(
      car,
      recoverCarBodyBeforeStep,
      generated,
      1,
      'car',
    );
    const ballRecoveredFields = exercisePerFieldRecovery(
      ball,
      recoverBallBeforeStep,
      generated,
      20,
      'ball',
    );

    car.setLinvel(generated.carLinearOverCap, true);
    car.setAngvel(generated.carAngularOverCap, true);
    const boundedCar = recoverCarBodyAfterStep(car);
    const carLinearSpeed = magnitude(boundedCar.linearVelocity);
    const carAngularSpeed = magnitude(boundedCar.angularVelocity);
    assertApproximately(carLinearSpeed, CAR_LINEAR_CAP, 'car linear cap');
    assertApproximately(carAngularSpeed, CAR_ANGULAR_CAP, 'car angular cap');
    assert.ok(carLinearSpeed <= CAR_LINEAR_CAP + EPSILON);
    assert.ok(carAngularSpeed <= CAR_ANGULAR_CAP + EPSILON);
    assertDirectionPreserved(
      generated.carLinearOverCap,
      boundedCar.linearVelocity,
      'car linear direction',
    );
    assertDirectionPreserved(
      generated.carAngularOverCap,
      boundedCar.angularVelocity,
      'car angular direction',
    );

    ball.setLinvel(generated.ballLinearOverCap, true);
    ball.setAngvel(generated.ballAngularOverCap, true);
    const boundedBall = recoverBallAfterStep(ball);
    const ballLinearSpeed = magnitude(boundedBall.linearVelocity);
    const ballAngularSpeed = magnitude(boundedBall.angularVelocity);
    assertApproximately(ballLinearSpeed, BALL_LINEAR_CAP, 'ball linear cap');
    assertApproximately(ballAngularSpeed, BALL_ANGULAR_CAP, 'ball angular cap');
    assert.ok(ballLinearSpeed <= BALL_LINEAR_CAP + EPSILON);
    assert.ok(ballAngularSpeed <= BALL_ANGULAR_CAP + EPSILON);
    assertDirectionPreserved(
      generated.ballLinearOverCap,
      boundedBall.linearVelocity,
      'ball linear direction',
    );
    assertDirectionPreserved(
      generated.ballAngularOverCap,
      boundedBall.angularVelocity,
      'ball angular direction',
    );

    const exposed = Object.freeze({
      plan,
      boundedCar,
      boundedBall,
      carBody: bodyExposure(car),
      ballBody: bodyExposure(ball),
    });
    assertFiniteNumbers(exposed, 'exposed');

    return Object.freeze({
      plan: Object.freeze({
        forwardSpeed: plan.forwardSpeed,
        propulsionProjectedForwardSpeed: plan.propulsionProjectedForwardSpeed,
        projectedSpeed: magnitude(plan.projectedVelocity),
        projectedAngularSpeed: magnitude(plan.projectedAngularVelocity),
        boostActuated: plan.boostActuated,
        jumpEvent: plan.jumpAirControl?.event ?? null,
      }),
      car: Object.freeze({
        linearSpeed: carLinearSpeed,
        angularSpeed: carAngularSpeed,
        recoveredFields: carRecoveredFields,
      }),
      ball: Object.freeze({
        linearSpeed: ballLinearSpeed,
        angularSpeed: ballAngularSpeed,
        recoveredFields: ballRecoveredFields,
      }),
      cleanupCount: 1,
    });
  } finally {
    world.free();
    cleanupCount += 1;
    assert.equal(cleanupCount, 1, 'each generated Rapier world must be freed exactly once');
  }
}

function requireProjection(
  core: AuthoritativeRoomCore<RAPIER.World, AuthoritativeRapierCar, RAPIER.RigidBody>,
): Readonly<AuthoritativeRoomProjection> {
  const projection = core.projectAuthoritativeState();
  assert.ok(projection, 'ready production core must expose its committed projection');
  return projection;
}

function initialCarPosition(
  _entry: Pick<RosterEntry, 'acceptedJoinOrdinal' | 'team'>,
  tuning: RoomPinnedTuningSnapshot,
): Readonly<{ x: number; y: number; z: number }> {
  return Object.freeze({
    x: 0,
    y: getScalarTuningValue(tuning, TUNING_IDS.car.collider.height) / 2 + 0.02,
    z: 0,
  });
}

/**
 * Timer exposure is checked through supported lifecycle inputs. Stored boost is
 * deliberately corrupted through the captured production car so this property
 * proves last-finite recovery and clamping at the authoritative ownership edge.
 */
async function verifyReachableProductionExposure(): Promise<Readonly<{
  regulationStepsRemaining: number;
  boost: number;
}>> {
  type RapierCore = AuthoritativeRoomCore<
    RAPIER.World,
    AuthoritativeRapierCar,
    RAPIER.RigidBody
  >;

  let disposeCalls = 0;
  let capturedBundle: AuthoritativeRapierRoomWorldBundle | null = null;
  const core: RapierCore = new AuthoritativeRoomCore({
    roomId: 'property-10-reachable-authoritative-exposure',
    mode: 'custom',
    policy: ROOM_POLICIES.custom,
    initializeWorld: async (context) => {
      const base = await initializeAuthoritativeRapierWorld(context, {
        resolvedGeometry: ARENA_COLLISION_GEOMETRY,
        initialCarPosition,
      });
      capturedBundle = {
        ...base,
        dispose: () => {
          disposeCalls += 1;
          base.dispose();
        },
      };
      return capturedBundle;
    },
    logger: { info: () => {}, error: () => {} },
  });

  await core.initialize();
  try {
    assert.ok(capturedBundle);
    const joinCompletion = core.queueMutation({
      kind: 'join',
      sessionId: 'host',
      name: 'Property 10 Host',
    });
    const joinFrame = core.advanceSimulation(FIXED_STEP_MS);
    assert.equal(joinFrame.scheduledFixedSteps, 1);
    assert.equal(joinFrame.executedFixedSteps, 1);
    const joinResult = await joinCompletion;
    assert.equal(joinResult.ok, true, joinResult.ok ? undefined : joinResult.message);

    const startCompletion = core.queueMutation({ kind: 'start', sessionId: 'host' });
    const startFrame = core.advanceSimulation(FIXED_STEP_MS);
    assert.equal(startFrame.scheduledFixedSteps, 1);
    assert.equal(startFrame.executedFixedSteps, 1);
    const startResult = await startCompletion;
    assert.equal(startResult.ok, true, startResult.ok ? undefined : startResult.message);

    for (let index = 0; index < MATCH_RULES.kickoffCountdownSteps; index += 1) {
      const frame = core.advanceSimulation(FIXED_STEP_MS);
      assert.equal(frame.scheduledFixedSteps, 1);
      assert.equal(frame.executedFixedSteps, 1);
    }
    assert.equal(requireProjection(core).phase, 'playing');

    const car = (
      capturedBundle as AuthoritativeRapierRoomWorldBundle
    ).carsBySessionId.get('host');
    assert.ok(car, 'the joined production car must remain reachable in the world bundle');
    let activeSteps = 0;
    const advanceActiveStep = (): Readonly<AuthoritativeRoomProjection> => {
      const frame = core.advanceSimulation(FIXED_STEP_MS);
      assert.equal(frame.scheduledFixedSteps, 1);
      assert.equal(frame.executedFixedSteps, 1);
      activeSteps += 1;
      const value = requireProjection(core);
      assertFiniteNumbers(value, `reachableProjection.step${activeSteps}`);
      return value;
    };

    const lastValidatedBoost = 37.5;
    car.boostAmount = lastValidatedBoost;
    let projection = advanceActiveStep();
    assert.equal(projection.cars[0]!.boost, lastValidatedBoost);

    for (const invalidBoost of NON_FINITE_VALUES) {
      car.boostAmount = invalidBoost;
      projection = advanceActiveStep();
      assert.equal(
        projection.cars[0]!.boost,
        lastValidatedBoost,
        `${invalidBoost} inventory must recover to its last validated finite value`,
      );
      assert.equal(car.boostAmount, lastValidatedBoost);
    }

    car.boostAmount = 150;
    projection = advanceActiveStep();
    assert.equal(projection.cars[0]!.boost, 100, 'finite inventory must clamp at 100');
    car.boostAmount = -25;
    projection = advanceActiveStep();
    assert.equal(projection.cars[0]!.boost, 0, 'finite inventory must clamp at zero');
    car.boostAmount = Number.NaN;
    projection = advanceActiveStep();
    assert.equal(
      projection.cars[0]!.boost,
      0,
      'non-finite inventory must recover to the latest clamped finite value',
    );

    const snapshot = core.buildSnapshotV2(projection, 123_456);
    assert.ok(snapshot);
    assertFiniteNumbers(snapshot, 'reachableSnapshot');
    assert.equal(
      projection.regulationStepsRemaining,
      MATCH_RULES.regulationActivePlaySteps - activeSteps,
    );
    assert.equal(projection.cars.length, 1);

    return Object.freeze({
      regulationStepsRemaining: projection.regulationStepsRemaining,
      boost: projection.cars[0]!.boost,
    });
  } finally {
    core.dispose();
    assert.equal(disposeCalls, 1, 'production Rapier room world must be disposed exactly once');
  }
}

function canonicalInputTrace(generatedCase: GeneratedCase<GeneratedFiniteBoundsCase>): unknown {
  return Object.freeze({
    seed: generatedCase.seed,
    index: generatedCase.index,
    ...generatedCase.value,
  });
}

function executeGeneratedCases(
  cases: readonly GeneratedCase<GeneratedFiniteBoundsCase>[],
): readonly FiniteBoundsTrace[] {
  const traces: FiniteBoundsTrace[] = [];
  assertGeneratedCases(cases, (generated, generatedCase) => {
    assert.equal(generated.caseIndex, generatedCase.index);
    traces.push(exerciseFiniteBoundsCase(generated));
  });
  return Object.freeze(traces);
}

/**
 * Feature: rocket-arena, Property 10: Finite authoritative output and body speed bounds
 * **Validates: Requirements 7.8-7.12, 8.10, 9.16, 11.4-11.5, 11.11, 18.11, 18.25**
 */
test(
  `Property 10: finite output and exact body bounds (seed=${RECORDED_SEED}, cases=${GENERATED_CASE_COUNT})`,
  async () => {
    await initPhysics();

    assert.equal(CAR_LINEAR_SPEED_TOLERANCE, 0.05);
    assert.equal(BALL_LINEAR_SPEED_TOLERANCE, 0.05);
    assert.equal(
      getScalarTuningValue(DEFAULT_TUNING_REGISTRY_SNAPSHOT, TUNING_IDS.car.maxLinearSpeed)
        + CAR_LINEAR_SPEED_TOLERANCE,
      CAR_LINEAR_CAP,
    );
    assert.equal(
      getScalarTuningValue(DEFAULT_TUNING_REGISTRY_SNAPSHOT, TUNING_IDS.car.maxAngularSpeed),
      CAR_ANGULAR_CAP,
    );
    assert.equal(
      getScalarTuningValue(DEFAULT_TUNING_REGISTRY_SNAPSHOT, TUNING_IDS.ball.maxLinearSpeed)
        + BALL_LINEAR_SPEED_TOLERANCE,
      BALL_LINEAR_CAP,
    );
    assert.equal(
      getScalarTuningValue(DEFAULT_TUNING_REGISTRY_SNAPSHOT, TUNING_IDS.ball.maxAngularSpeed),
      BALL_ANGULAR_CAP,
    );

    const cases = generateCases({
      seed: RECORDED_SEED,
      count: GENERATED_CASE_COUNT,
      generate: generateFiniteBoundsCase,
    });
    const regeneratedCases = generateCases({
      seed: RECORDED_SEED,
      count: GENERATED_CASE_COUNT,
      generate: generateFiniteBoundsCase,
    });
    const replayedCase = replayCase(
      RECORDED_SEED,
      REPLAY_CASE_INDEX,
      generateFiniteBoundsCase,
    );

    assert.equal(cases.length, GENERATED_CASE_COUNT);
    assert.equal(regeneratedCases.length, GENERATED_CASE_COUNT);
    assert.deepEqual(
      cases.map(canonicalInputTrace),
      regeneratedCases.map(canonicalInputTrace),
    );
    assert.deepEqual(
      canonicalInputTrace(replayedCase),
      canonicalInputTrace(cases[REPLAY_CASE_INDEX]!),
    );
    const finiteCases = cases.filter(({ value }) => value.mode === 'finite');
    const nonFiniteCases = cases.filter(({ value }) => value.mode === 'non-finite');
    assert.equal(finiteCases.length, 20);
    assert.equal(nonFiniteCases.length, 80);
    assert.ok(finiteCases.every(({ value }) => value.nonFiniteOrdinal === null));
    assert.deepEqual(
      nonFiniteCases.map(({ value }) => value.nonFiniteOrdinal),
      Array.from({ length: nonFiniteCases.length }, (_, index) => index),
      'non-finite selectors must use a contiguous ordinal independent of finite cases',
    );
    assert.deepEqual(
      [...new Set(nonFiniteCases.map(({ value }) => value.malformedInputAxis))],
      [...CONTROLLER_AXIS_FIELDS],
      'every controller axis must receive a non-finite generated value',
    );
    assert.deepEqual(
      [...new Set(nonFiniteCases.map(({ value }) => value.malformedObservationField))],
      [...CONTROLLER_OBSERVATION_FIELDS],
      'every recoverable controller observation field must be malformed',
    );
    assert.deepEqual(
      [...new Set(nonFiniteCases.map(({ value }) => value.invalidScalarTuningId))],
      [...INVALID_SCALAR_IDS],
      'every intended scalar tuning ID must receive a non-finite override',
    );
    for (const { value } of nonFiniteCases) {
      assert.notEqual(value.malformedInputAxis, null);
      assert.equal(
        Number.isFinite(value.input[value.malformedInputAxis!]),
        false,
        `${value.malformedInputAxis} must actually be non-finite`,
      );
      assert.equal(value.tuningOverrides[0]?.id, value.invalidScalarTuningId);
      assert.equal(typeof value.tuningOverrides[0]?.value, 'number');
      assert.equal(Number.isFinite(value.tuningOverrides[0]!.value as number), false);
    }
    for (const observationField of CONTROLLER_OBSERVATION_FIELDS.slice(0, 3)) {
      const fieldCases = nonFiniteCases.filter(
        ({ value }) => value.malformedObservationField === observationField,
      );
      assert.ok(
        fieldCases.some(({ value }) => value.previousFiniteState === undefined),
        `${observationField} must exercise immutable-default recovery`,
      );
      assert.ok(
        fieldCases.some(({ value }) => value.previousFiniteState !== undefined),
        `${observationField} must exercise same-field previous-state recovery`,
      );
    }
    assert.ok(nonFiniteCases.some(({ value }) => (
      value.malformedObservationField === 'surfaceBasis'
      && value.observation.grounded === true
    )));
    assert.deepEqual(
      [...new Set(cases.map(({ value }) => value.observation.grounded))].sort(),
      [false, true],
    );

    const firstTraces = executeGeneratedCases(cases);
    const regeneratedTraces = executeGeneratedCases(regeneratedCases);
    assert.deepEqual(regeneratedTraces, firstTraces);

    const replayedTrace = executeGeneratedCases([replayedCase])[0];
    assert.deepEqual(replayedTrace, firstTraces[REPLAY_CASE_INDEX]);
    assertGeneratedCases(cases, (_generated, generatedCase) => {
      assert.deepEqual(
        regeneratedTraces[generatedCase.index],
        firstTraces[generatedCase.index],
      );
    });

    const reachable = await verifyReachableProductionExposure();
    assertFiniteNumbers(reachable, 'reachableTimerAndInventory');
  },
);
