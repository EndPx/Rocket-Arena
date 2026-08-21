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
  evaluateNonIncreasingThrottleCurve,
  planCarControllerCommand,
  type CarControllerPlan,
  type CarControllerTuningSnapshot,
  type ControllerQuaternion,
  type ControllerVector3,
} from './car-controller.js';

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

const RECORDED_SEED = 'rocket-arena-property-9-throttle-v1';
const GENERATED_CASE_COUNT = 160;
const REPLAY_CASE_INDICES = Object.freeze([0, 79, 80, GENERATED_CASE_COUNT - 1]);
const EPSILON = 1e-9;
const IDENTITY_ROTATION: ControllerQuaternion = Object.freeze({ x: 0, y: 0, z: 0, w: 1 });
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
const BOOST_ACCELERATION = getScalarTuningValue(
  DEFAULT_TUNING_REGISTRY_SNAPSHOT,
  TUNING_IDS.car.boost.acceleration,
);
const MAXIMUM_PROPULSION_SPEED = getScalarTuningValue(
  DEFAULT_TUNING_REGISTRY_SNAPSHOT,
  TUNING_IDS.car.maxLinearSpeed,
);

const BOUNDARY_SCENARIOS = Object.freeze([
  'zero',
  'first-curve-knot',
  'second-curve-knot',
  'just-below-target',
  'exact-target',
  'just-above-target',
  'just-below-maximum',
  'exact-maximum',
] as const);
type BoundaryScenario = (typeof BOUNDARY_SCENARIOS)[number];

const BOOST_MODES = Object.freeze([
  'not-held-empty',
  'held-available',
  'held-empty',
  'not-held-available',
] as const);
type BoostMode = (typeof BOOST_MODES)[number];

interface GeneratedThrottleCase {
  readonly caseIndex: number;
  readonly boundaryScenario: BoundaryScenario;
  readonly boostMode: BoostMode;
  readonly lowerSpeed: number;
  readonly higherSpeed: number;
  readonly probeSpeed: number;
  readonly lowerThrottleMagnitude: number;
  readonly higherThrottleMagnitude: number;
  readonly normalizedInput: number;
  readonly boundarySpeed: number;
  readonly boostHeld: boolean;
  readonly availableBoost: number;
}

function command(patch: Partial<InputCommandV2>): Readonly<InputCommandV2> {
  return Object.freeze({ ...NEUTRAL_COMMAND, ...patch });
}

function boundarySpeedFor(scenario: BoundaryScenario): number {
  switch (scenario) {
    case 'zero': return 0;
    case 'first-curve-knot': return 5;
    case 'second-curve-knot': return 10;
    case 'just-below-target': return TARGET_SPEED - 1e-9;
    case 'exact-target': return TARGET_SPEED;
    case 'just-above-target': return TARGET_SPEED + 1e-9;
    case 'just-below-maximum': return MAXIMUM_PROPULSION_SPEED - 1e-9;
    case 'exact-maximum': return MAXIMUM_PROPULSION_SPEED;
  }
}

function randomBetween(random: SeededRandom, minimum: number, maximum: number): number {
  return minimum + (maximum - minimum) * random.next();
}

function orderedSubTargetSpeeds(
  random: SeededRandom,
  caseIndex: number,
): readonly [number, number] {
  switch (caseIndex % 4) {
    case 0: return [0.001, 5];
    case 1: return [5, 10];
    case 2: return [10, TARGET_SPEED - 0.001];
    default: {
      const lower = randomBetween(random, 0.001, TARGET_SPEED - 0.2);
      const higher = randomBetween(random, lower + 0.001, TARGET_SPEED - 0.001);
      return [lower, higher];
    }
  }
}

function orderedThrottleMagnitudes(
  random: SeededRandom,
  caseIndex: number,
): readonly [number, number] {
  switch (caseIndex % 4) {
    case 0: return [0.25, 1];
    case 1: return [0.01, 0.5];
    default: {
      const lower = randomBetween(random, 0.01, 0.49);
      const higher = randomBetween(random, lower + 0.01, 1);
      return [lower, higher];
    }
  }
}

function generateThrottleCase(
  random: SeededRandom,
  caseIndex: number,
): GeneratedThrottleCase {
  const boundaryScenario = BOUNDARY_SCENARIOS[caseIndex % BOUNDARY_SCENARIOS.length]!;
  const boostMode = BOOST_MODES[
    Math.floor(caseIndex / BOUNDARY_SCENARIOS.length) % BOOST_MODES.length
  ]!;
  const [lowerSpeed, higherSpeed] = orderedSubTargetSpeeds(random, caseIndex);
  const [lowerThrottleMagnitude, higherThrottleMagnitude] = orderedThrottleMagnitudes(
    random,
    caseIndex,
  );
  const exactInputs = [-1, -0.5, 0, 0.5, 1] as const;
  const inputSlot = caseIndex % 6;
  const normalizedInput = inputSlot < exactInputs.length
    ? exactInputs[inputSlot]!
    : randomBetween(random, -1, 1);
  const hasInventory = boostMode === 'held-available' || boostMode === 'not-held-available';

  return Object.freeze({
    caseIndex,
    boundaryScenario,
    boostMode,
    lowerSpeed,
    higherSpeed,
    probeSpeed: randomBetween(random, lowerSpeed, higherSpeed),
    lowerThrottleMagnitude,
    higherThrottleMagnitude,
    normalizedInput,
    boundarySpeed: boundarySpeedFor(boundaryScenario),
    boostHeld: boostMode === 'held-available' || boostMode === 'held-empty',
    availableBoost: hasInventory ? randomBetween(random, 0.001, 100) : 0,
  });
}

function planAtSpeed(
  speed: number,
  input: Readonly<InputCommandV2>,
  availableBoost = 0,
  tuning: CarControllerTuningSnapshot = DEFAULT_TUNING_REGISTRY_SNAPSHOT,
): CarControllerPlan {
  return planCarControllerCommand(input, {
    observation: {
      rotation: IDENTITY_ROTATION,
      linearVelocity: { x: 0, y: 0, z: speed },
      angularVelocity: { x: 0, y: 0, z: 0 },
      grounded: true,
      surfaceBasis: null,
    },
    availableBoost,
    tuning,
    timestepSeconds: FIXED_STEP_SECONDS,
    dragEnabled: false,
  });
}

function executeThrottleCase(generated: GeneratedThrottleCase) {
  return {
    lowerFullThrottle: planAtSpeed(generated.lowerSpeed, command({ throttle: 1 })),
    higherFullThrottle: planAtSpeed(generated.higherSpeed, command({ throttle: 1 })),
    fullProbeThrottle: planAtSpeed(generated.probeSpeed, command({ throttle: 1 })),
    zeroProbeThrottle: planAtSpeed(generated.probeSpeed, command({ throttle: 0 })),
    lowerProbeThrottle: planAtSpeed(
      generated.probeSpeed,
      command({ throttle: generated.lowerThrottleMagnitude }),
    ),
    higherProbeThrottle: planAtSpeed(
      generated.probeSpeed,
      command({ throttle: generated.higherThrottleMagnitude }),
    ),
    boundaryNoBoost: planAtSpeed(
      generated.boundarySpeed,
      command({ throttle: 1, boostHeld: false }),
      0,
    ),
    boundaryCommand: planAtSpeed(
      generated.boundarySpeed,
      command({
        throttle: generated.normalizedInput,
        boostHeld: generated.boostHeld,
      }),
      generated.availableBoost,
    ),
  };
}

type ExecutedThrottleCase = ReturnType<typeof executeThrottleCase>;

function resultFingerprint(executed: ExecutedThrottleCase): unknown {
  const fingerprintPlan = (plan: CarControllerPlan) => ({
    normalizedThrottle: plan.normalizedThrottle,
    throttleAcceleration: plan.throttleAcceleration,
    boostAcceleration: plan.boostAcceleration,
    requestedPropulsionAcceleration: plan.requestedPropulsionAcceleration,
    appliedPropulsionDeltaVelocity: plan.appliedPropulsionDeltaVelocity,
    propulsionProjectedForwardSpeed: plan.propulsionProjectedForwardSpeed,
    boostActuated: plan.boostActuated,
  });

  return Object.fromEntries(
    Object.entries(executed).map(([key, plan]) => [key, fingerprintPlan(plan)]),
  );
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

function assertFiniteThrottlePlan(plan: CarControllerPlan, label: string): void {
  for (const [scalarLabel, scalar] of [
    ['forwardSpeed', plan.forwardSpeed],
    ['normalizedThrottle', plan.normalizedThrottle],
    ['propulsionProjectedForwardSpeed', plan.propulsionProjectedForwardSpeed],
  ] as const) {
    assert.ok(Number.isFinite(scalar), `${label}.${scalarLabel} must be finite`);
  }
  for (const [vectorLabel, vector] of [
    ['localForward', plan.localForward],
    ['throttleAcceleration', plan.throttleAcceleration],
    ['boostAcceleration', plan.boostAcceleration],
    ['requestedPropulsionAcceleration', plan.requestedPropulsionAcceleration],
    ['requestedPropulsionDeltaVelocity', plan.requestedPropulsionDeltaVelocity],
    ['appliedPropulsionDeltaVelocity', plan.appliedPropulsionDeltaVelocity],
    ['propulsionProjectedVelocity', plan.propulsionProjectedVelocity],
    ['projectedVelocity', plan.projectedVelocity],
  ] as const) {
    assertFiniteVector(vector, `${label}.${vectorLabel}`);
  }
}

function tuningWithThrottleCurve(curve: StructuredCurve): CarControllerTuningSnapshot {
  return {
    get(id: string) {
      const entry = DEFAULT_TUNING_REGISTRY_SNAPSHOT.get(id);
      if (id === TUNING_IDS.car.throttle.accelerationCurve && entry?.kind === 'curve') {
        return { ...entry, value: curve };
      }
      return entry;
    },
  };
}

/**
 * Feature: rocket-arena, Property 9: Throttle curve monotonicity and input scaling
 * **Validates: Requirements 8.4-8.7, 18.1-18.2, 18.25**
 */
test(
  `Property 9: throttle monotonicity, scaling, target, boost, and cap (seed=${RECORDED_SEED}, cases=${GENERATED_CASE_COUNT})`,
  () => {
    assert.ok(GENERATED_CASE_COUNT >= 100, 'Property 9 requires at least 100 ordered cases');
    const generatedCases = generateCases({
      seed: RECORDED_SEED,
      count: GENERATED_CASE_COUNT,
      generate: generateThrottleCase,
    });
    const regeneratedCases = generateCases({
      seed: RECORDED_SEED,
      count: GENERATED_CASE_COUNT,
      generate: generateThrottleCase,
    });

    assert.equal(generatedCases.length, GENERATED_CASE_COUNT);
    assert.deepEqual(regeneratedCases, generatedCases);
    for (const replayIndex of REPLAY_CASE_INDICES) {
      assert.deepEqual(
        replayCase(RECORDED_SEED, replayIndex, generateThrottleCase),
        generatedCases[replayIndex],
      );
    }
    assert.deepEqual(
      regeneratedCases.map(({ value }) => resultFingerprint(executeThrottleCase(value))),
      generatedCases.map(({ value }) => resultFingerprint(executeThrottleCase(value))),
      'rerunning the recorded seed must reproduce the same ordered results',
    );

    const boundaryCounts = generatedCases.reduce<Record<BoundaryScenario, number>>(
      (counts, generatedCase) => {
        counts[generatedCase.value.boundaryScenario] += 1;
        return counts;
      },
      {
        zero: 0,
        'first-curve-knot': 0,
        'second-curve-knot': 0,
        'just-below-target': 0,
        'exact-target': 0,
        'just-above-target': 0,
        'just-below-maximum': 0,
        'exact-maximum': 0,
      },
    );
    assert.deepEqual(boundaryCounts, {
      zero: 20,
      'first-curve-knot': 20,
      'second-curve-knot': 20,
      'just-below-target': 20,
      'exact-target': 20,
      'just-above-target': 20,
      'just-below-maximum': 20,
      'exact-maximum': 20,
    });

    const boostModeCounts = generatedCases.reduce<Record<BoostMode, number>>(
      (counts, generatedCase) => {
        counts[generatedCase.value.boostMode] += 1;
        return counts;
      },
      {
        'not-held-empty': 0,
        'held-available': 0,
        'held-empty': 0,
        'not-held-available': 0,
      },
    );
    assert.deepEqual(boostModeCounts, {
      'not-held-empty': 40,
      'held-available': 40,
      'held-empty': 40,
      'not-held-available': 40,
    });

    assertGeneratedCases(generatedCases, (generated, generatedCase) => {
      assert.equal(generatedCase.seed, RECORDED_SEED);
      assert.equal(generatedCase.index, generated.caseIndex);
      assert.equal(generated.boundarySpeed, boundarySpeedFor(generated.boundaryScenario));
      assert.ok([
        generated.lowerSpeed,
        generated.higherSpeed,
        generated.probeSpeed,
        generated.lowerThrottleMagnitude,
        generated.higherThrottleMagnitude,
        generated.normalizedInput,
        generated.boundarySpeed,
        generated.availableBoost,
      ].every(Number.isFinite), 'every generated throttle input must be finite');
      assert.ok(
        generated.lowerSpeed > 0
          && generated.lowerSpeed < generated.higherSpeed
          && generated.higherSpeed < TARGET_SPEED,
        'monotonicity speeds must occupy a strict nonzero sub-target domain',
      );
      assert.ok(
        generated.probeSpeed >= generated.lowerSpeed
          && generated.probeSpeed <= generated.higherSpeed,
      );
      assert.ok(
        generated.lowerThrottleMagnitude > 0
          && generated.lowerThrottleMagnitude < generated.higherThrottleMagnitude
          && generated.higherThrottleMagnitude <= 1,
        'scaling inputs must occupy a strict nonzero normalized domain',
      );
      assert.ok(generated.normalizedInput >= -1 && generated.normalizedInput <= 1);

      const executed = executeThrottleCase(generated);
      assert.deepEqual(
        executeThrottleCase(generated),
        executed,
        'the same generated command sequence must produce the same result',
      );
      for (const [label, plan] of Object.entries(executed)) {
        assertFiniteThrottlePlan(plan, label);
      }

      const lowerFullAcceleration = executed.lowerFullThrottle.throttleAcceleration.z;
      const higherFullAcceleration = executed.higherFullThrottle.throttleAcceleration.z;
      assert.ok(lowerFullAcceleration > 0 && higherFullAcceleration > 0);
      assert.ok(
        higherFullAcceleration <= lowerFullAcceleration + EPSILON,
        `full-throttle acceleration increased from ${lowerFullAcceleration} to ${higherFullAcceleration}`,
      );

      assert.deepEqual(executed.zeroProbeThrottle.throttleAcceleration, { x: 0, y: 0, z: 0 });
      const fullProbeAcceleration = executed.fullProbeThrottle.throttleAcceleration.z;
      const lowerScaledAcceleration = executed.lowerProbeThrottle.throttleAcceleration.z;
      const higherScaledAcceleration = executed.higherProbeThrottle.throttleAcceleration.z;
      assert.ok(fullProbeAcceleration > 0);
      assert.ok(lowerScaledAcceleration > 0 && higherScaledAcceleration > lowerScaledAcceleration);
      assertApproximately(
        lowerScaledAcceleration,
        fullProbeAcceleration * generated.lowerThrottleMagnitude,
        'lower normalized throttle scaling',
      );
      assertApproximately(
        higherScaledAcceleration,
        fullProbeAcceleration * generated.higherThrottleMagnitude,
        'higher normalized throttle scaling',
      );

      assert.equal(executed.boundaryNoBoost.boostActuated, false);
      assert.deepEqual(executed.boundaryNoBoost.boostAcceleration, { x: 0, y: 0, z: 0 });
      if (generated.boundarySpeed < TARGET_SPEED) {
        assert.ok(executed.boundaryNoBoost.throttleAcceleration.z > 0);
      } else {
        assert.deepEqual(
          executed.boundaryNoBoost.throttleAcceleration,
          { x: 0, y: 0, z: 0 },
        );
      }
      assert.ok(
        executed.boundaryNoBoost.propulsionProjectedForwardSpeed
          <= MAXIMUM_PROPULSION_SPEED + EPSILON,
      );

      const expectedBoostActuation = generated.boostHeld && generated.availableBoost > 0;
      assert.equal(executed.boundaryCommand.normalizedThrottle, generated.normalizedInput);
      assert.equal(executed.boundaryCommand.boostActuated, expectedBoostActuation);
      assertApproximately(
        executed.boundaryCommand.boostAcceleration.z,
        expectedBoostActuation ? BOOST_ACCELERATION : 0,
        'boost must be independent of throttle-curve output',
      );
      assert.ok(
        Math.abs(executed.boundaryCommand.propulsionProjectedForwardSpeed)
          <= MAXIMUM_PROPULSION_SPEED + EPSILON,
        'applied propulsion projection must remain inside the 23 m/s cap',
      );
    });
  },
);

test('Property 9 exact boundaries and malformed inputs remain deterministic and finite', () => {
  assert.equal(TARGET_SPEED, 14.1);
  assert.equal(BOOST_ACCELERATION, 9.91666);
  assert.equal(MAXIMUM_PROPULSION_SPEED, 23);

  const curve = getCurveTuningValue(
    DEFAULT_TUNING_REGISTRY_SNAPSHOT,
    TUNING_IDS.car.throttle.accelerationCurve,
  );
  // The seeded samples are Rocket League's throttle curve: 16 m/s^2 from rest,
  // 1.6 m/s^2 at 14 m/s, nothing at the 14.1 m/s ceiling. The two off-sample
  // speeds pin the interpolation between them.
  for (const [speed, expectedAcceleration] of [
    [0, 16],
    [7, 8.8],
    [14, 1.6],
    [14.05, 0.8],
    [TARGET_SPEED, 0],
  ] as const) {
    assertApproximately(
      evaluateNonIncreasingThrottleCurve(curve, speed),
      expectedAcceleration,
      `exact throttle curve boundary ${speed}`,
    );
  }
  assert.equal(
    evaluateNonIncreasingThrottleCurve(curve, Number.NaN),
    curve.samples[0]!.output,
    'a malformed evaluation speed must recover to the finite first sample',
  );

  const malformedCurves: readonly StructuredCurve[] = [
    {
      outputOrder: 'non-increasing',
      samples: [{ input: 0, output: 1 }, { input: 0, output: 0 }],
    },
    {
      outputOrder: 'non-increasing',
      samples: [{ input: 0, output: 1 }, { input: 1, output: 2 }],
    },
    {
      outputOrder: 'non-increasing',
      samples: [{ input: 0, output: 1 }, { input: 1, output: Number.NaN }],
    },
  ];
  for (const malformedCurve of malformedCurves) {
    assert.throws(
      () => evaluateNonIncreasingThrottleCurve(malformedCurve, 0.5),
      /finite, ordered, non-increasing/,
    );
  }

  const fallbackPlan = planAtSpeed(
    5,
    command({ throttle: 1 }),
    0,
    tuningWithThrottleCurve(malformedCurves[1]!),
  );
  // A malformed injected curve falls back to the seeded one, so the expectation
  // is read from that curve rather than restated as a literal.
  assertApproximately(
    fallbackPlan.throttleAcceleration.z,
    evaluateNonIncreasingThrottleCurve(curve, 5),
    'malformed tuning curve fallback',
  );
  assertFiniteThrottlePlan(fallbackPlan, 'malformed tuning fallback');

  const atTargetNoBoost = planAtSpeed(
    TARGET_SPEED,
    command({ throttle: 1, boostHeld: false }),
  );
  assert.deepEqual(atTargetNoBoost.throttleAcceleration, { x: 0, y: 0, z: 0 });
  assertApproximately(
    atTargetNoBoost.propulsionProjectedForwardSpeed,
    TARGET_SPEED,
    'exact target without boost',
  );

  const atTargetWithBoost = planAtSpeed(
    TARGET_SPEED,
    command({ throttle: 1, boostHeld: true }),
    100,
  );
  assert.deepEqual(atTargetWithBoost.throttleAcceleration, { x: 0, y: 0, z: 0 });
  assert.equal(atTargetWithBoost.boostActuated, true);
  assertApproximately(atTargetWithBoost.boostAcceleration.z, BOOST_ACCELERATION, 'exact boost');
  assertApproximately(
    atTargetWithBoost.propulsionProjectedForwardSpeed,
    TARGET_SPEED + BOOST_ACCELERATION * FIXED_STEP_SECONDS,
    'boost projection above target',
  );

  const atMaximumWithBoost = planAtSpeed(
    MAXIMUM_PROPULSION_SPEED,
    command({ throttle: 1, boostHeld: true }),
    100,
  );
  assertApproximately(atMaximumWithBoost.boostAcceleration.z, BOOST_ACCELERATION, 'requested cap boost');
  assert.deepEqual(atMaximumWithBoost.appliedPropulsionDeltaVelocity, { x: 0, y: 0, z: 0 });
  assertApproximately(
    atMaximumWithBoost.propulsionProjectedForwardSpeed,
    MAXIMUM_PROPULSION_SPEED,
    'exact 23 m/s propulsion projection',
  );

  const heldWithoutInventory = planAtSpeed(
    TARGET_SPEED,
    command({ throttle: 1, boostHeld: true }),
    0,
  );
  assert.equal(heldWithoutInventory.boostActuated, false);
  assert.deepEqual(heldWithoutInventory.boostAcceleration, { x: 0, y: 0, z: 0 });

  const malformedInput = planAtSpeed(5, command({ throttle: Number.NaN }));
  assert.equal(malformedInput.normalizedThrottle, 0);
  assert.deepEqual(malformedInput.throttleAcceleration, { x: 0, y: 0, z: 0 });
  assertFiniteThrottlePlan(malformedInput, 'malformed throttle input recovery');
});
