import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_TUNING_REGISTRY_SNAPSHOT,
  INPUT_PROTOCOL_VERSION,
  TUNING_IDS,
  getCurveTuningValue,
  getScalarTuningValue,
  type InputCommandV2,
  type StructuredCurve,
} from '@rocket-arena/shared';
import {
  planCarControllerCommand,
  type CarControllerPlan,
  type ControllerQuaternion,
  type ControllerSurfaceBasis,
  type ControllerVector3,
} from './car-controller.js';
import { createSurfaceRelativeBasis } from './grounding.js';

interface SeededRandom {
  next(): number;
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

// This shared helper is test infrastructure outside server/src. Loading its source
// URL preserves one deterministic generator implementation without widening rootDir.
const generatedCasesModuleUrl = new URL(
  '../../../shared/tests/support/generated-cases.ts',
  import.meta.url,
).href;
const {
  assertGeneratedCases,
  generateCases,
  replayCase,
} = await import(generatedCasesModuleUrl) as unknown as GeneratedCasesModule;

const RECORDED_SEED = 'rocket-arena-property-11-grip-handbrake-v1';
const GENERATED_CASE_COUNT = 160;
const REPLAY_CASE_INDICES = Object.freeze([0, 39, 80, GENERATED_CASE_COUNT - 1]);
const EPSILON = 1e-8;
const IDENTITY_ROTATION: ControllerQuaternion = Object.freeze({ x: 0, y: 0, z: 0, w: 1 });
const LOCAL_FORWARD: ControllerVector3 = Object.freeze({ x: 0, y: 0, z: 1 });
const NEUTRAL_COMMAND: Readonly<InputCommandV2> = Object.freeze({
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

const FIXED_STEP_SECONDS = getScalarTuningValue(
  DEFAULT_TUNING_REGISTRY_SNAPSHOT,
  TUNING_IDS.physics.fixedStepSeconds,
);
const TARGET_SPEED = getScalarTuningValue(
  DEFAULT_TUNING_REGISTRY_SNAPSHOT,
  TUNING_IDS.car.throttle.targetSpeed,
);
const MAXIMUM_PROPULSION_SPEED = getScalarTuningValue(
  DEFAULT_TUNING_REGISTRY_SNAPSHOT,
  TUNING_IDS.car.maxLinearSpeed,
);
const STEERING_CURVATURE_CURVE = getCurveTuningValue(
  DEFAULT_TUNING_REGISTRY_SNAPSHOT,
  TUNING_IDS.car.steering.curvatureCurve,
);
const NORMAL_GRIP_RATE = getScalarTuningValue(
  DEFAULT_TUNING_REGISTRY_SNAPSHOT,
  TUNING_IDS.car.steering.normalGripRate,
);
const HANDBRAKE_GRIP_RATE = getScalarTuningValue(
  DEFAULT_TUNING_REGISTRY_SNAPSHOT,
  TUNING_IDS.car.steering.powerslideGripRate,
);
const HANDBRAKE_CURVATURE_MULTIPLIER = getScalarTuningValue(
  DEFAULT_TUNING_REGISTRY_SNAPSHOT,
  TUNING_IDS.car.steering.powerslideCurvatureMultiplier,
);

const NORMAL_SCENARIOS = Object.freeze([
  'floor',
  'positive-bank',
  'wall',
  'ceiling',
  'compound-slope',
  'near-local-forward',
  'generated-upper-hemisphere',
  'generated-lower-hemisphere',
] as const);
type NormalScenario = (typeof NORMAL_SCENARIOS)[number];

const SPEED_SCENARIOS = Object.freeze([
  'nonzero-minimum',
  'first-curve-knot',
  'exact-target',
  'exact-maximum',
  'generated',
] as const);
type SpeedScenario = (typeof SPEED_SCENARIOS)[number];

interface GeneratedGripCase {
  readonly caseIndex: number;
  readonly normalScenario: NormalScenario;
  readonly speedScenario: SpeedScenario;
  readonly surfaceNormal: Readonly<ControllerVector3>;
  readonly forwardSpeed: number;
  readonly lateralSpeed: number;
  readonly normalSpeed: number;
  readonly steer: number;
  readonly currentYawRate: number;
  readonly forwardAngularRate: number;
  readonly rightAngularRate: number;
}

function command(patch: Partial<InputCommandV2>): Readonly<InputCommandV2> {
  return Object.freeze({ ...NEUTRAL_COMMAND, ...patch });
}

function randomBetween(random: SeededRandom, minimum: number, maximum: number): number {
  return minimum + (maximum - minimum) * random.next();
}

function independentlyEvaluateSteeringCurvature(
  curve: StructuredCurve,
  speed: number,
): number {
  assert.ok(Number.isFinite(speed), 'independent steering oracle requires finite speed');
  assert.ok(curve.samples.length >= 2, 'independent steering oracle requires curve samples');
  const absoluteSpeed = Math.abs(speed);
  const first = curve.samples[0]!;
  if (absoluteSpeed <= first.input) return first.output;

  for (let index = 1; index < curve.samples.length; index += 1) {
    const right = curve.samples[index]!;
    if (absoluteSpeed > right.input) continue;
    const left = curve.samples[index - 1]!;
    const interpolation = (absoluteSpeed - left.input) / (right.input - left.input);
    return left.output + (right.output - left.output) * interpolation;
  }
  return curve.samples[curve.samples.length - 1]!.output;
}

function surfaceNormalFor(
  scenario: NormalScenario,
  random: SeededRandom,
): Readonly<ControllerVector3> {
  switch (scenario) {
    case 'floor': return Object.freeze({ x: 0, y: 1, z: 0 });
    case 'positive-bank': return Object.freeze({ x: 1, y: 1, z: 0 });
    case 'wall': return Object.freeze({ x: 1, y: 0, z: 0 });
    case 'ceiling': return Object.freeze({ x: 0, y: -1, z: 0 });
    case 'compound-slope': return Object.freeze({ x: -0.4, y: 0.8, z: 0.4 });
    case 'near-local-forward': return Object.freeze({ x: 0.2, y: 0.1, z: 0.97 });
    case 'generated-upper-hemisphere':
    case 'generated-lower-hemisphere': {
      let x = randomBetween(random, -1, 1);
      const y = scenario === 'generated-upper-hemisphere'
        ? randomBetween(random, 0.1, 1)
        : randomBetween(random, -1, -0.1);
      const z = randomBetween(random, -0.85, 0.85);
      if (Math.hypot(x, y) < 0.2) x = x < 0 ? -0.2 : 0.2;
      return Object.freeze({ x, y, z });
    }
  }
}

function speedMagnitudeFor(
  scenario: SpeedScenario,
  random: SeededRandom,
): number {
  switch (scenario) {
    case 'nonzero-minimum': return 0.25;
    case 'first-curve-knot': return 5;
    case 'exact-target': return TARGET_SPEED;
    case 'exact-maximum': return MAXIMUM_PROPULSION_SPEED;
    case 'generated': return randomBetween(random, 0.25, MAXIMUM_PROPULSION_SPEED);
  }
}

function generateGripCase(random: SeededRandom, caseIndex: number): GeneratedGripCase {
  const normalScenario = NORMAL_SCENARIOS[caseIndex % NORMAL_SCENARIOS.length]!;
  const speedScenario = SPEED_SCENARIOS[
    Math.floor(caseIndex / NORMAL_SCENARIOS.length) % SPEED_SCENARIOS.length
  ]!;
  const forwardSign = Math.floor(
    caseIndex / (NORMAL_SCENARIOS.length * SPEED_SCENARIOS.length),
  ) % 2 === 0 ? 1 : -1;
  const lateralSign = Math.floor(caseIndex / 2) % 2 === 0 ? 1 : -1;
  const steerSign = Math.floor(caseIndex / 4) % 2 === 0 ? 1 : -1;
  const yawSign = Math.floor(caseIndex / 3) % 2 === 0 ? 1 : -1;
  const lateralMagnitude = caseIndex % 5 === 0
    ? 0.25
    : caseIndex % 5 === 1
      ? 8
      : randomBetween(random, 0.25, 12);
  const steerMagnitude = caseIndex % 4 === 0
    ? 0.05
    : caseIndex % 4 === 1
      ? 1
      : randomBetween(random, 0.05, 1);

  return Object.freeze({
    caseIndex,
    normalScenario,
    speedScenario,
    surfaceNormal: surfaceNormalFor(normalScenario, random),
    forwardSpeed: forwardSign * speedMagnitudeFor(speedScenario, random),
    lateralSpeed: lateralSign * lateralMagnitude,
    normalSpeed: randomBetween(random, -2, 2),
    steer: steerSign * steerMagnitude,
    currentYawRate: yawSign * randomBetween(random, 0.25, 5),
    forwardAngularRate: randomBetween(random, -1.5, 1.5),
    rightAngularRate: randomBetween(random, -1.5, 1.5),
  });
}

function scale(vector: ControllerVector3, scalar: number): ControllerVector3 {
  return { x: vector.x * scalar, y: vector.y * scalar, z: vector.z * scalar };
}

function add(left: ControllerVector3, right: ControllerVector3): ControllerVector3 {
  return { x: left.x + right.x, y: left.y + right.y, z: left.z + right.z };
}

function dot(left: ControllerVector3, right: ControllerVector3): number {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

function magnitude(vector: ControllerVector3): number {
  return Math.hypot(vector.x, vector.y, vector.z);
}

function planGrounded(
  input: Readonly<InputCommandV2>,
  linearVelocity: ControllerVector3,
  angularVelocity: ControllerVector3,
  surfaceBasis: ControllerSurfaceBasis,
): CarControllerPlan {
  return planCarControllerCommand(input, {
    observation: {
      rotation: IDENTITY_ROTATION,
      linearVelocity,
      angularVelocity,
      grounded: true,
      surfaceBasis,
    },
    availableBoost: 0,
    timestepSeconds: FIXED_STEP_SECONDS,
    dragEnabled: false,
  });
}

function executeGripCase(generated: GeneratedGripCase) {
  const basis: ControllerSurfaceBasis = createSurfaceRelativeBasis(
    generated.surfaceNormal,
    LOCAL_FORWARD,
  );
  const linearVelocity = add(
    add(
      scale(basis.forward, generated.forwardSpeed),
      scale(basis.right, generated.lateralSpeed),
    ),
    scale(basis.normal, generated.normalSpeed),
  );
  const angularVelocity = add(
    add(
      scale(basis.normal, generated.currentYawRate),
      scale(basis.forward, generated.forwardAngularRate),
    ),
    scale(basis.right, generated.rightAngularRate),
  );

  // Task 5.9 names this handbrake behavior; powerslideHeld is the current
  // InputCommandV2/server contract bit that selects that behavior.
  const normalGrip = planGrounded(
    command({ steer: generated.steer, powerslideHeld: false }),
    linearVelocity,
    angularVelocity,
    basis,
  );
  const handbrakeGrip = planGrounded(
    command({ steer: generated.steer, powerslideHeld: true }),
    linearVelocity,
    angularVelocity,
    basis,
  );
  const zeroSteerNormal = planGrounded(
    command({ steer: 0, powerslideHeld: false }),
    linearVelocity,
    angularVelocity,
    basis,
  );
  const zeroSteerHandbrake = planGrounded(
    command({ steer: 0, powerslideHeld: true }),
    linearVelocity,
    angularVelocity,
    basis,
  );

  return {
    basis,
    linearVelocity,
    angularVelocity,
    normalGrip,
    handbrakeGrip,
    zeroSteerNormal,
    zeroSteerHandbrake,
  };
}

type ExecutedGripCase = ReturnType<typeof executeGripCase>;

function resultFingerprint(executed: ExecutedGripCase): unknown {
  const fingerprintPlan = (plan: CarControllerPlan) => ({
    normalizedSteer: plan.normalizedSteer,
    lateralGripDeltaVelocity: plan.lateralGripDeltaVelocity,
    projectedVelocity: plan.projectedVelocity,
    angularDeltaVelocity: plan.angularDeltaVelocity,
    projectedAngularVelocity: plan.projectedAngularVelocity,
    groundedControl: plan.groundedControl,
  });
  return {
    basis: executed.basis,
    linearVelocity: executed.linearVelocity,
    angularVelocity: executed.angularVelocity,
    normalGrip: fingerprintPlan(executed.normalGrip),
    handbrakeGrip: fingerprintPlan(executed.handbrakeGrip),
    zeroSteerNormal: fingerprintPlan(executed.zeroSteerNormal),
    zeroSteerHandbrake: fingerprintPlan(executed.zeroSteerHandbrake),
  };
}

function assertApproximately(actual: number, expected: number, label: string): void {
  const tolerance = EPSILON * Math.max(1, Math.abs(expected));
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: expected ${expected}, received ${actual}`,
  );
}

function assertFiniteVector(vector: ControllerVector3, label: string): void {
  assert.ok(
    [vector.x, vector.y, vector.z].every(Number.isFinite),
    `${label} must contain only finite components`,
  );
}

function assertFiniteBasis(basis: ControllerSurfaceBasis, label: string): void {
  assertFiniteVector(basis.normal, `${label}.normal`);
  assertFiniteVector(basis.forward, `${label}.forward`);
  assertFiniteVector(basis.right, `${label}.right`);
  assertApproximately(magnitude(basis.normal), 1, `${label}.normal length`);
  assertApproximately(magnitude(basis.forward), 1, `${label}.forward length`);
  assertApproximately(magnitude(basis.right), 1, `${label}.right length`);
  assertApproximately(dot(basis.normal, basis.forward), 0, `${label}.normal-forward tangent`);
  assertApproximately(dot(basis.normal, basis.right), 0, `${label}.normal-right tangent`);
  assertApproximately(dot(basis.forward, basis.right), 0, `${label}.forward-right tangent`);
}

function assertFiniteGripPlan(plan: CarControllerPlan, label: string): void {
  assert.ok(plan.groundedControl !== null, `${label} must resolve grounded control`);
  const grounded = plan.groundedControl;
  for (const [scalarLabel, scalar] of [
    ['forwardSpeed', plan.forwardSpeed],
    ['normalizedSteer', plan.normalizedSteer],
    ['surfaceForwardSpeed', grounded.surfaceForwardSpeed],
    ['surfaceLateralSpeed', grounded.surfaceLateralSpeed],
    ['gripRate', grounded.gripRate],
    ['gripAlpha', grounded.gripAlpha],
    ['baseCurvature', grounded.baseCurvature],
    ['commandedCurvature', grounded.commandedCurvature],
    ['currentYawRate', grounded.currentYawRate],
    ['targetYawRate', grounded.targetYawRate],
  ] as const) {
    assert.ok(Number.isFinite(scalar), `${label}.${scalarLabel} must be finite`);
  }
  for (const [vectorLabel, vector] of [
    ['lateralGripDeltaVelocity', plan.lateralGripDeltaVelocity],
    ['projectedVelocity', plan.projectedVelocity],
    ['angularDeltaVelocity', plan.angularDeltaVelocity],
    ['projectedAngularVelocity', plan.projectedAngularVelocity],
  ] as const) {
    assertFiniteVector(vector, `${label}.${vectorLabel}`);
  }
  assertFiniteBasis(grounded.basis, `${label}.basis`);
}

/**
 * Feature: rocket-arena, Property 11: Grip and handbrake ordering
 * **Validates: Requirements 8.11-8.16, 18.3-18.4, 18.25**
 */
test(
  `Property 11: grip and handbrake ordering through powerslideHeld server contract (seed=${RECORDED_SEED}, cases=${GENERATED_CASE_COUNT})`,
  () => {
    assert.ok(GENERATED_CASE_COUNT >= 100, 'Property 11 requires at least 100 ordered cases');
    const generatedCases = generateCases({
      seed: RECORDED_SEED,
      count: GENERATED_CASE_COUNT,
      generate: generateGripCase,
    });
    const regeneratedCases = generateCases({
      seed: RECORDED_SEED,
      count: GENERATED_CASE_COUNT,
      generate: generateGripCase,
    });

    assert.equal(generatedCases.length, GENERATED_CASE_COUNT);
    assert.deepEqual(regeneratedCases, generatedCases);
    for (const replayIndex of REPLAY_CASE_INDICES) {
      assert.deepEqual(
        replayCase(RECORDED_SEED, replayIndex, generateGripCase),
        generatedCases[replayIndex],
      );
    }
    assert.deepEqual(
      regeneratedCases.map(({ value }) => resultFingerprint(executeGripCase(value))),
      generatedCases.map(({ value }) => resultFingerprint(executeGripCase(value))),
      'rerunning the recorded seed must reproduce the same ordered results',
    );

    const normalScenarioCounts = generatedCases.reduce<Record<NormalScenario, number>>(
      (counts, generatedCase) => {
        counts[generatedCase.value.normalScenario] += 1;
        return counts;
      },
      {
        floor: 0,
        'positive-bank': 0,
        wall: 0,
        ceiling: 0,
        'compound-slope': 0,
        'near-local-forward': 0,
        'generated-upper-hemisphere': 0,
        'generated-lower-hemisphere': 0,
      },
    );
    assert.deepEqual(normalScenarioCounts, {
      floor: 20,
      'positive-bank': 20,
      wall: 20,
      ceiling: 20,
      'compound-slope': 20,
      'near-local-forward': 20,
      'generated-upper-hemisphere': 20,
      'generated-lower-hemisphere': 20,
    });

    const speedScenarioCounts = generatedCases.reduce<Record<SpeedScenario, number>>(
      (counts, generatedCase) => {
        counts[generatedCase.value.speedScenario] += 1;
        return counts;
      },
      {
        'nonzero-minimum': 0,
        'first-curve-knot': 0,
        'exact-target': 0,
        'exact-maximum': 0,
        generated: 0,
      },
    );
    assert.deepEqual(speedScenarioCounts, {
      'nonzero-minimum': 32,
      'first-curve-knot': 32,
      'exact-target': 32,
      'exact-maximum': 32,
      generated: 32,
    });

    assertGeneratedCases(generatedCases, (generated, generatedCase) => {
      assert.equal(generatedCase.seed, RECORDED_SEED);
      assert.equal(generatedCase.index, generated.caseIndex);
      assert.ok([
        generated.surfaceNormal.x,
        generated.surfaceNormal.y,
        generated.surfaceNormal.z,
        generated.forwardSpeed,
        generated.lateralSpeed,
        generated.normalSpeed,
        generated.steer,
        generated.currentYawRate,
        generated.forwardAngularRate,
        generated.rightAngularRate,
      ].every(Number.isFinite), 'every generated grounded input must be finite');
      assert.ok(magnitude(generated.surfaceNormal) > 0, 'surface normal must be nonzero');
      assert.ok(
        Math.hypot(generated.surfaceNormal.x, generated.surfaceNormal.y) > 0,
        'surface normal must leave a nonzero local-forward tangent',
      );
      assert.ok(generated.forwardSpeed !== 0, 'strict curvature ordering needs nonzero speed');
      assert.ok(generated.lateralSpeed !== 0, 'strict grip ordering needs nonzero lateral speed');
      assert.ok(generated.steer !== 0, 'strict curvature ordering needs nonzero steering');
      assert.ok(generated.currentYawRate !== 0, 'strict zero-steer decay needs nonzero yaw');
      assert.ok(Math.abs(generated.forwardSpeed) <= MAXIMUM_PROPULSION_SPEED);
      assert.ok(Math.abs(generated.steer) <= 1);

      const executed = executeGripCase(generated);
      assert.deepEqual(
        executeGripCase(generated),
        executed,
        'the same generated grounded state must produce the same result',
      );
      assertFiniteBasis(executed.basis, 'generated basis');
      assertFiniteVector(executed.linearVelocity, 'generated linear velocity');
      assertFiniteVector(executed.angularVelocity, 'generated angular velocity');
      assertFiniteGripPlan(executed.normalGrip, 'normal grip');
      assertFiniteGripPlan(executed.handbrakeGrip, 'handbrake grip');
      assertFiniteGripPlan(executed.zeroSteerNormal, 'zero-steer normal grip');
      assertFiniteGripPlan(executed.zeroSteerHandbrake, 'zero-steer handbrake grip');

      const normal = executed.normalGrip.groundedControl!;
      const handbrake = executed.handbrakeGrip.groundedControl!;
      assert.equal(normal.powerslideActive, false);
      assert.equal(handbrake.powerslideActive, true);
      assertApproximately(normal.surfaceForwardSpeed, generated.forwardSpeed, 'surface forward speed');
      assertApproximately(normal.surfaceLateralSpeed, generated.lateralSpeed, 'surface lateral speed');
      assert.equal(normal.gripRate, NORMAL_GRIP_RATE);
      assert.equal(handbrake.gripRate, HANDBRAKE_GRIP_RATE);
      assert.ok(
        normal.gripRate > handbrake.gripRate && handbrake.gripRate > 0,
        'normal grip rate must be strictly greater than handbrake grip rate',
      );
      assert.ok(
        normal.gripAlpha > handbrake.gripAlpha && handbrake.gripAlpha > 0,
        'normal per-step response must be strictly greater than handbrake response',
      );
      assertApproximately(
        normal.gripAlpha,
        1 - Math.exp(-NORMAL_GRIP_RATE * FIXED_STEP_SECONDS),
        'normal exponential grip alpha',
      );
      assertApproximately(
        handbrake.gripAlpha,
        1 - Math.exp(-HANDBRAKE_GRIP_RATE * FIXED_STEP_SECONDS),
        'handbrake exponential grip alpha',
      );

      const normalCorrection = magnitude(executed.normalGrip.lateralGripDeltaVelocity);
      const handbrakeCorrection = magnitude(executed.handbrakeGrip.lateralGripDeltaVelocity);
      assert.ok(
        normalCorrection > handbrakeCorrection && handbrakeCorrection > 0,
        'equal-state normal correction must be strictly larger than handbrake correction',
      );

      const initialLateralMagnitude = Math.abs(generated.lateralSpeed);
      const normalResidual = dot(executed.normalGrip.projectedVelocity, executed.basis.right);
      const handbrakeResidual = dot(
        executed.handbrakeGrip.projectedVelocity,
        executed.basis.right,
      );
      assert.ok(
        Math.abs(normalResidual) < Math.abs(handbrakeResidual)
          && Math.abs(handbrakeResidual) < initialLateralMagnitude,
        'both modes must decay lateral speed and normal grip must leave less residual',
      );
      assert.equal(Math.sign(normalResidual), Math.sign(generated.lateralSpeed));
      assert.equal(Math.sign(handbrakeResidual), Math.sign(generated.lateralSpeed));
      assertApproximately(
        Math.abs(normalResidual),
        initialLateralMagnitude * Math.exp(-NORMAL_GRIP_RATE * FIXED_STEP_SECONDS),
        'normal lateral decay',
      );
      assertApproximately(
        Math.abs(handbrakeResidual),
        initialLateralMagnitude * Math.exp(-HANDBRAKE_GRIP_RATE * FIXED_STEP_SECONDS),
        'handbrake lateral decay',
      );

      const expectedBaseCurvature = generated.steer
        * independentlyEvaluateSteeringCurvature(
          STEERING_CURVATURE_CURVE,
          generated.forwardSpeed,
        );
      assertApproximately(
        normal.baseCurvature,
        expectedBaseCurvature,
        'configured speed-dependent base curvature',
      );
      assertApproximately(
        handbrake.baseCurvature,
        expectedBaseCurvature,
        'handbrake configured base curvature',
      );
      assertApproximately(normal.baseCurvature, handbrake.baseCurvature, 'equal-state base curvature');
      assertApproximately(normal.commandedCurvature, normal.baseCurvature, 'normal curvature');
      assertApproximately(
        handbrake.commandedCurvature,
        normal.commandedCurvature * HANDBRAKE_CURVATURE_MULTIPLIER,
        'handbrake curvature multiplier',
      );
      assert.ok(
        Math.abs(handbrake.commandedCurvature) > Math.abs(normal.commandedCurvature),
        'handbrake curvature magnitude must be strictly greater',
      );
      assert.equal(Math.sign(normal.commandedCurvature), Math.sign(generated.steer));
      assert.equal(Math.sign(handbrake.commandedCurvature), Math.sign(normal.commandedCurvature));
      assert.ok(Math.abs(handbrake.targetYawRate) > Math.abs(normal.targetYawRate));
      assert.equal(
        Math.sign(handbrake.targetYawRate),
        Math.sign(generated.steer * generated.forwardSpeed),
      );

      const initialYawMagnitude = Math.abs(dot(executed.angularVelocity, executed.basis.normal));
      const initialForwardAngular = dot(executed.angularVelocity, executed.basis.forward);
      const initialRightAngular = dot(executed.angularVelocity, executed.basis.right);
      for (const [label, zeroSteerPlan] of [
        ['normal', executed.zeroSteerNormal],
        ['handbrake', executed.zeroSteerHandbrake],
      ] as const) {
        const zeroSteer = zeroSteerPlan.groundedControl!;
        assert.equal(zeroSteerPlan.normalizedSteer, 0);
        assertApproximately(zeroSteer.baseCurvature, 0, `${label} zero-steer base curvature`);
        assertApproximately(
          zeroSteer.commandedCurvature,
          0,
          `${label} zero-steer commanded curvature`,
        );
        assertApproximately(zeroSteer.targetYawRate, 0, `${label} zero-steer target yaw`);
        const projectedYaw = dot(zeroSteerPlan.projectedAngularVelocity, executed.basis.normal);
        assert.ok(
          Math.abs(projectedYaw) < initialYawMagnitude,
          `${label} zero-steer yaw must decay`,
        );
        assertApproximately(projectedYaw, 0, `${label} zero-steer projected yaw`);
        assertApproximately(
          dot(zeroSteerPlan.projectedAngularVelocity, executed.basis.forward),
          initialForwardAngular,
          `${label} zero-steer preserves forward-tangent angular rate`,
        );
        assertApproximately(
          dot(zeroSteerPlan.projectedAngularVelocity, executed.basis.right),
          initialRightAngular,
          `${label} zero-steer preserves right-tangent angular rate`,
        );
      }
    });
  },
);

test('Property 11 exact grip boundaries and malformed geometry stay finite', () => {
  assert.equal(NORMAL_GRIP_RATE, 12);
  assert.equal(HANDBRAKE_GRIP_RATE, 4);
  assert.equal(HANDBRAKE_CURVATURE_MULTIPLIER, 1.5);
  assert.ok(NORMAL_GRIP_RATE > HANDBRAKE_GRIP_RATE && HANDBRAKE_GRIP_RATE > 0);
  assert.deepEqual(STEERING_CURVATURE_CURVE.samples, [
    { input: 0, output: 0.18 },
    { input: 5, output: 0.14 },
    { input: 14.1, output: 0.08 },
    { input: 23, output: 0.04 },
  ]);
  for (const [speed, expectedCurvature] of [
    [0, 0.18],
    [5, 0.14],
    [14.1, 0.08],
    [23, 0.04],
  ] as const) {
    assertApproximately(
      independentlyEvaluateSteeringCurvature(STEERING_CURVATURE_CURVE, speed),
      expectedCurvature,
      `independent steering curve boundary ${speed}`,
    );
  }

  const flatBasis: ControllerSurfaceBasis = createSurfaceRelativeBasis(
    { x: 0, y: 1, z: 0 },
    LOCAL_FORWARD,
  );
  assertFiniteBasis(flatBasis, 'exact flat basis');
  const exactVelocity = add(
    scale(flatBasis.forward, MAXIMUM_PROPULSION_SPEED),
    scale(flatBasis.right, 8),
  );
  const exactAngularVelocity = scale(flatBasis.normal, 3);
  const exactNormal = planGrounded(
    command({ steer: 1, powerslideHeld: false }),
    exactVelocity,
    exactAngularVelocity,
    flatBasis,
  );
  const exactHandbrake = planGrounded(
    command({ steer: 1, powerslideHeld: true }),
    exactVelocity,
    exactAngularVelocity,
    flatBasis,
  );
  assertFiniteGripPlan(exactNormal, 'exact normal boundary');
  assertFiniteGripPlan(exactHandbrake, 'exact handbrake boundary');
  assert.ok(
    magnitude(exactNormal.lateralGripDeltaVelocity)
      > magnitude(exactHandbrake.lateralGripDeltaVelocity),
  );
  assertApproximately(
    exactHandbrake.groundedControl!.commandedCurvature,
    exactNormal.groundedControl!.commandedCurvature * HANDBRAKE_CURVATURE_MULTIPLIER,
    'exact maximum-speed handbrake curvature',
  );

  const recoveredBasis: ControllerSurfaceBasis = createSurfaceRelativeBasis(
    { x: Number.NaN, y: Number.POSITIVE_INFINITY, z: 0 },
    { x: Number.NaN, y: 0, z: Number.NEGATIVE_INFINITY },
  );
  assertFiniteBasis(recoveredBasis, 'malformed grounding basis recovery');

  const malformedBasis: ControllerSurfaceBasis = {
    normal: { x: Number.NaN, y: 1, z: 0 },
    forward: { x: 0, y: 0, z: 1 },
    right: { x: 1, y: 0, z: 0 },
  };
  const rejectedMalformedBasis = planGrounded(
    command({ steer: 1, powerslideHeld: true }),
    exactVelocity,
    exactAngularVelocity,
    malformedBasis,
  );
  assert.equal(rejectedMalformedBasis.groundedControl, null);
  assert.deepEqual(rejectedMalformedBasis.lateralGripDeltaVelocity, { x: 0, y: 0, z: 0 });
  assert.deepEqual(rejectedMalformedBasis.angularDeltaVelocity, { x: 0, y: 0, z: 0 });
  assertFiniteVector(rejectedMalformedBasis.projectedVelocity, 'rejected malformed basis velocity');
  assertFiniteVector(
    rejectedMalformedBasis.projectedAngularVelocity,
    'rejected malformed basis angular velocity',
  );

  const malformedSteer = planGrounded(
    command({ steer: Number.NaN, powerslideHeld: true }),
    exactVelocity,
    exactAngularVelocity,
    flatBasis,
  );
  assertFiniteGripPlan(malformedSteer, 'malformed steer recovery');
  assert.equal(malformedSteer.normalizedSteer, 0);
  assert.equal(malformedSteer.groundedControl!.commandedCurvature, 0);
  assert.equal(malformedSteer.groundedControl!.targetYawRate, 0);
  assertApproximately(
    dot(malformedSteer.projectedAngularVelocity, flatBasis.normal),
    0,
    'malformed steer recovers to zero-steer yaw decay',
  );
});
