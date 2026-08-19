import assert from 'node:assert/strict';
import test from 'node:test';
import RAPIER from '@dimforge/rapier3d-compat';
import {
  DEFAULT_TUNING_REGISTRY_SNAPSHOT,
  TUNING_IDS,
  getScalarTuningValue,
  type FiniteRange,
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
  createCarBody,
  recoverCarBodyAfterStep,
  recoverCarBodyBeforeStep,
} from './car-body.js';
import { createWorld, initPhysics } from './world.js';

interface SeededRandom {
  next(): number;
  integer(minInclusive: number, maxInclusive: number): number;
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

// The shared helper is intentionally outside server/src. Runtime loading keeps
// one generator implementation without widening the production emit root.
const generatedCasesModuleUrl = new URL(
  '../../../shared/tests/support/generated-cases.ts',
  import.meta.url,
).href;
const {
  assertGeneratedCases,
  generateCases,
  replayCase,
} = await import(generatedCasesModuleUrl) as unknown as GeneratedCasesModule;

const RECORDED_SEED = 'rocket-arena-property-23-physics-construction-v1';
const GENERATED_CASE_COUNT = 120;
const REPLAY_CASE_INDEX = 83;
const COLLISION_STEP_LIMIT = 60;
const POST_CONTACT_TRACE_STEPS = 12;
const EPSILON = 1e-5;
const TRACE_PRECISION = 1e8;

type PhysicsTuningSnapshot = Pick<TuningRegistrySnapshot, 'get'>;

interface GeneratedConstructionCase {
  readonly caseIndex: number;
  readonly carLength: number;
  readonly carWidth: number;
  readonly carHeight: number;
  readonly ballLinearDamping: number;
  readonly approachSpeed: number;
  readonly lateralOffset: number;
  readonly separation: number;
}

interface ScriptedBallActuationCounts {
  addForce: number;
  addForceAtPoint: number;
  addTorque: number;
  applyImpulse: number;
  applyImpulseAtPoint: number;
  applyTorqueImpulse: number;
}

interface CollisionTraceSample {
  readonly step: number;
  readonly contactPoints: number;
  readonly normalImpulse: number;
  readonly tangentImpulse: number;
  readonly rawBallAngularSpeed: number;
  readonly boundedBallAngularSpeed: number;
  readonly boundedBallLinearSpeed: number;
  readonly ballPosition: readonly [number, number, number];
  readonly ballAngularVelocity: readonly [number, number, number];
}

interface ConstructionResultTrace {
  readonly seed: string;
  readonly index: number;
  readonly dimensions: readonly [number, number, number];
  readonly damping: number;
  readonly contactStep: number;
  readonly peakRawBallSpin: number;
  readonly peakBoundedBallSpin: number;
  readonly peakBallSpeed: number;
  readonly peakBallHorizontalSpeed: number;
  readonly scriptedBallActuation: Readonly<ScriptedBallActuationCounts>;
  readonly collisionTrace: readonly CollisionTraceSample[];
  readonly recoveredLinearSpeed: number;
  readonly recoveredAngularSpeed: number;
}

interface DisposalTracker {
  created: number;
  freed: number;
}

const disposalTracker: DisposalTracker = { created: 0, freed: 0 };

function scalarEntry(id: string): Extract<TuningEntry, { kind: 'scalar' }> {
  const entry = DEFAULT_TUNING_REGISTRY_SNAPSHOT.get(id);
  if (entry?.kind !== 'scalar') throw new TypeError(`Expected scalar tuning entry ${id}.`);
  return entry;
}

function scalarRange(id: string): FiniteRange {
  return scalarEntry(id).validatedRange;
}

function scalarValue(id: string): number {
  return getScalarTuningValue(DEFAULT_TUNING_REGISTRY_SNAPSHOT, id);
}

function sampleRange(random: SeededRandom, range: FiniteRange): number {
  if (range.min === range.max) return range.min;
  return Number((range.min + (range.max - range.min) * random.next()).toFixed(9));
}

function rangeValue(
  random: SeededRandom,
  id: string,
  endpoint: 'min' | 'max' | null,
): number {
  const range = scalarRange(id);
  return endpoint === null ? sampleRange(random, range) : range[endpoint];
}

function generateConstructionCase(
  random: SeededRandom,
  caseIndex: number,
): GeneratedConstructionCase {
  const endpointSlot = caseIndex % 8;
  const carLength = rangeValue(
    random,
    TUNING_IDS.car.collider.length,
    endpointSlot === 0 ? 'min' : endpointSlot === 1 ? 'max' : null,
  );
  const carWidth = rangeValue(
    random,
    TUNING_IDS.car.collider.width,
    endpointSlot === 2 ? 'min' : endpointSlot === 3 ? 'max' : null,
  );
  const carHeight = rangeValue(
    random,
    TUNING_IDS.car.collider.height,
    endpointSlot === 4 ? 'min' : endpointSlot === 5 ? 'max' : null,
  );
  const dampingEndpoint = caseIndex % 6;
  const ballLinearDamping = rangeValue(
    random,
    TUNING_IDS.ball.linearDamping,
    dampingEndpoint === 0 ? 'min' : dampingEndpoint === 1 ? 'max' : null,
  );
  const radius = scalarValue(TUNING_IDS.ball.radius);
  const offsetFromCarEdge = radius * (0.1 + random.next() * 0.15);

  return Object.freeze({
    caseIndex,
    carLength,
    carWidth,
    carHeight,
    ballLinearDamping,
    approachSpeed: Number((15 + random.next() * 6).toFixed(9)),
    lateralOffset: Number((
      (random.integer(0, 1) === 0 ? -1 : 1)
      * (carWidth / 2 + offsetFromCarEdge)
    ).toFixed(9)),
    separation: Number((1 + random.next()).toFixed(9)),
  });
}

function tuningWithScalarOverrides(
  overrides: ReadonlyMap<string, number>,
): PhysicsTuningSnapshot {
  return {
    get(id: string): TuningEntry | undefined {
      const entry = DEFAULT_TUNING_REGISTRY_SNAPSHOT.get(id);
      const replacement = overrides.get(id);
      if (entry?.kind !== 'scalar' || replacement === undefined) return entry;
      return { ...entry, value: replacement };
    },
  };
}

function tuningForCase(generated: GeneratedConstructionCase): PhysicsTuningSnapshot {
  return tuningWithScalarOverrides(new Map([
    [TUNING_IDS.car.collider.length, generated.carLength],
    [TUNING_IDS.car.collider.width, generated.carWidth],
    [TUNING_IDS.car.collider.height, generated.carHeight],
    [TUNING_IDS.ball.linearDamping, generated.ballLinearDamping],
  ]));
}

function assertInValidatedRange(value: number, id: string): void {
  const range = scalarRange(id);
  assert.ok(Number.isFinite(value), `${id} must be finite`);
  assert.ok(
    value >= range.min && value <= range.max,
    `${id}=${value} must be inside [${range.min}, ${range.max}]`,
  );
}

function assertApproximately(actual: number, expected: number, label: string): void {
  assert.ok(
    Math.abs(actual - expected) <= EPSILON,
    `${label}: expected ${expected}, received ${actual}`,
  );
}

function vectorLength(vector: { x: number; y: number; z: number }): number {
  return Math.hypot(vector.x, vector.y, vector.z);
}

function assertFiniteVector(
  vector: { x: number; y: number; z: number },
  label: string,
): void {
  assert.ok(
    [vector.x, vector.y, vector.z].every(Number.isFinite),
    `${label} must contain only finite components`,
  );
}

function assertDirectionPreserved(
  before: { x: number; y: number; z: number },
  after: { x: number; y: number; z: number },
  label: string,
): void {
  const beforeLength = vectorLength(before);
  const afterLength = vectorLength(after);
  assert.ok(beforeLength > 0 && afterLength > 0, `${label} vectors must be non-zero`);
  assertApproximately(after.x / afterLength, before.x / beforeLength, `${label} x`);
  assertApproximately(after.y / afterLength, before.y / beforeLength, `${label} y`);
  assertApproximately(after.z / afterLength, before.z / beforeLength, `${label} z`);
}

function canonicalNumber(value: number): number {
  assert.ok(Number.isFinite(value), `trace value must be finite, received ${value}`);
  const rounded = Math.round(value * TRACE_PRECISION) / TRACE_PRECISION;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function canonicalVector(
  vector: { x: number; y: number; z: number },
): readonly [number, number, number] {
  assertFiniteVector(vector, 'trace vector');
  return Object.freeze([
    canonicalNumber(vector.x),
    canonicalNumber(vector.y),
    canonicalNumber(vector.z),
  ] as const);
}

function withTrackedWorld<T>(
  tuning: PhysicsTuningSnapshot,
  run: (world: RAPIER.World) => T,
): T {
  const world = createWorld(tuning);
  disposalTracker.created += 1;
  try {
    return run(world);
  } finally {
    world.free();
    disposalTracker.freed += 1;
  }
}

function instrumentScriptedBallActuation(
  ball: RAPIER.RigidBody,
): ScriptedBallActuationCounts {
  const counts: ScriptedBallActuationCounts = {
    addForce: 0,
    addForceAtPoint: 0,
    addTorque: 0,
    applyImpulse: 0,
    applyImpulseAtPoint: 0,
    applyTorqueImpulse: 0,
  };

  const originalAddForce = ball.addForce.bind(ball);
  ball.addForce = (...args: Parameters<RAPIER.RigidBody['addForce']>): void => {
    counts.addForce += 1;
    originalAddForce(...args);
  };
  const originalAddForceAtPoint = ball.addForceAtPoint.bind(ball);
  ball.addForceAtPoint = (
    ...args: Parameters<RAPIER.RigidBody['addForceAtPoint']>
  ): void => {
    counts.addForceAtPoint += 1;
    originalAddForceAtPoint(...args);
  };
  const originalAddTorque = ball.addTorque.bind(ball);
  ball.addTorque = (...args: Parameters<RAPIER.RigidBody['addTorque']>): void => {
    counts.addTorque += 1;
    originalAddTorque(...args);
  };
  const originalApplyImpulse = ball.applyImpulse.bind(ball);
  ball.applyImpulse = (...args: Parameters<RAPIER.RigidBody['applyImpulse']>): void => {
    counts.applyImpulse += 1;
    originalApplyImpulse(...args);
  };
  const originalApplyImpulseAtPoint = ball.applyImpulseAtPoint.bind(ball);
  ball.applyImpulseAtPoint = (
    ...args: Parameters<RAPIER.RigidBody['applyImpulseAtPoint']>
  ): void => {
    counts.applyImpulseAtPoint += 1;
    originalApplyImpulseAtPoint(...args);
  };
  const originalApplyTorqueImpulse = ball.applyTorqueImpulse.bind(ball);
  ball.applyTorqueImpulse = (
    ...args: Parameters<RAPIER.RigidBody['applyTorqueImpulse']>
  ): void => {
    counts.applyTorqueImpulse += 1;
    originalApplyTorqueImpulse(...args);
  };

  return counts;
}

function assertNoScriptedBallActuation(counts: ScriptedBallActuationCounts): void {
  assert.deepEqual(counts, {
    addForce: 0,
    addForceAtPoint: 0,
    addTorque: 0,
    applyImpulse: 0,
    applyImpulseAtPoint: 0,
    applyTorqueImpulse: 0,
  });
}

function assertConstruction(
  world: RAPIER.World,
  car: RAPIER.RigidBody,
  ball: RAPIER.RigidBody,
  generated: GeneratedConstructionCase,
): void {
  assertInValidatedRange(generated.carLength, TUNING_IDS.car.collider.length);
  assertInValidatedRange(generated.carWidth, TUNING_IDS.car.collider.width);
  assertInValidatedRange(generated.carHeight, TUNING_IDS.car.collider.height);
  assertInValidatedRange(generated.ballLinearDamping, TUNING_IDS.ball.linearDamping);

  assert.deepEqual(
    { x: world.gravity.x, y: world.gravity.y, z: world.gravity.z },
    { x: 0, y: -6.5, z: 0 },
  );
  assert.equal(scalarValue(TUNING_IDS.physics.fixedStepSeconds), 1 / 60);
  assertApproximately(world.timestep, 1 / 60, 'fixed world timestep');
  assert.equal(world.bodies.len(), 2, 'constructors must create only the car and ball bodies');
  assert.equal(world.colliders.len(), 2, 'constructors must create one collider per body');
  assert.equal(world.impulseJoints.len(), 0, 'plain scripted cars must have no wheel joints');
  assert.equal(world.multibodyJoints.len(), 0, 'plain scripted cars must have no wheel assemblies');

  assert.equal(car.isDynamic(), true);
  assert.equal(ball.isDynamic(), true);
  assert.equal(car.isCcdEnabled(), true, 'car CCD must be enabled');
  assert.equal(ball.isCcdEnabled(), true, 'ball CCD must be enabled');
  assert.equal(car.numColliders(), 1);
  assert.equal(ball.numColliders(), 1);

  const carCollider = car.collider(0);
  const ballCollider = ball.collider(0);
  assert.equal(carCollider.shape.type, RAPIER.ShapeType.Cuboid);
  assert.equal(ballCollider.shape.type, RAPIER.ShapeType.Ball);
  const carHalfExtents = (carCollider.shape as RAPIER.Cuboid).halfExtents;
  assertApproximately(carHalfExtents.x, generated.carWidth / 2, 'independent car half-width');
  assertApproximately(carHalfExtents.y, generated.carHeight / 2, 'independent car half-height');
  assertApproximately(carHalfExtents.z, generated.carLength / 2, 'independent car half-length');

  const expectedCarMass = scalarValue(TUNING_IDS.car.mass);
  const expectedBallMass = scalarValue(TUNING_IDS.ball.mass);
  const expectedRadius = scalarValue(TUNING_IDS.ball.radius);
  const expectedRestitution = scalarValue(TUNING_IDS.ball.restitution);
  assert.equal(expectedCarMass, 150);
  assert.equal(expectedBallMass, 25);
  assert.equal(expectedRadius, 0.9125);
  assert.equal(expectedRestitution, 0.6);
  assertApproximately(car.mass(), 150, 'car body mass');
  assertApproximately(carCollider.mass(), 150, 'car collider mass');
  assertApproximately(ball.mass(), 25, 'ball body mass');
  assertApproximately(ballCollider.mass(), 25, 'ball collider mass');
  assertApproximately(car.mass() / ball.mass(), 6, 'car-to-ball mass ratio');
  assertApproximately((ballCollider.shape as RAPIER.Ball).radius, 0.9125, 'ball radius');
  assertApproximately(ballCollider.restitution(), 0.6, 'ball restitution');
  assertApproximately(ball.linearDamping(), generated.ballLinearDamping, 'ball damping');
  assert.ok(ball.linearDamping() >= -EPSILON && ball.linearDamping() <= 0.2 + EPSILON);
}

function readContactImpulse(
  world: RAPIER.World,
  carCollider: RAPIER.Collider,
  ballCollider: RAPIER.Collider,
): { contactPoints: number; normalImpulse: number; tangentImpulse: number } {
  let contactPoints = 0;
  let normalImpulse = 0;
  let tangentImpulse = 0;
  world.contactPair(carCollider, ballCollider, (manifold) => {
    for (let index = 0; index < manifold.numContacts(); index += 1) {
      const normal = manifold.contactImpulse(index);
      const tangentX = manifold.contactTangentImpulseX(index);
      const tangentY = manifold.contactTangentImpulseY(index);
      contactPoints += 1;
      if (Number.isFinite(normal)) normalImpulse += Math.abs(normal);
      if (Number.isFinite(tangentX) && Number.isFinite(tangentY)) {
        tangentImpulse += Math.hypot(tangentX, tangentY);
      }
    }
  });
  return { contactPoints, normalImpulse, tangentImpulse };
}

function assertRecoveryDidNotAddMotion(
  before: { x: number; y: number; z: number },
  after: { x: number; y: number; z: number },
  maximum: number,
  label: string,
): void {
  const beforeMagnitude = vectorLength(before);
  const afterMagnitude = vectorLength(after);
  assertFiniteVector(before, `${label} before recovery`);
  assertFiniteVector(after, `${label} after recovery`);
  assert.ok(afterMagnitude <= maximum + EPSILON, `${label} must be capped at ${maximum}`);
  if (beforeMagnitude <= maximum + EPSILON) {
    assertApproximately(after.x, before.x, `${label} unchanged x`);
    assertApproximately(after.y, before.y, `${label} unchanged y`);
    assertApproximately(after.z, before.z, `${label} unchanged z`);
  } else {
    assertDirectionPreserved(before, after, `${label} cap direction`);
    assert.ok(afterMagnitude <= beforeMagnitude + EPSILON, `${label} recovery must not add motion`);
  }
}

function executeConstructionCase(
  generated: GeneratedConstructionCase,
  generatedCase: GeneratedCase<GeneratedConstructionCase>,
): ConstructionResultTrace {
  assert.equal(generatedCase.seed, RECORDED_SEED);
  assert.equal(generatedCase.index, generated.caseIndex);
  const tuning = tuningForCase(generated);

  return withTrackedWorld(tuning, (world) => {
    const ballRadius = scalarValue(TUNING_IDS.ball.radius);
    const centerY = 5;
    const ball = createBall(world, {
      x: generated.lateralOffset,
      y: centerY,
      z: 0,
    }, tuning);
    const car = createCarBody(world, {
      x: 0,
      y: centerY,
      z: -(generated.carLength / 2 + ballRadius + generated.separation),
    }, undefined, tuning);
    assertConstruction(world, car, ball, generated);

    const scriptedBallActuation = instrumentScriptedBallActuation(ball);
    const carCollider = car.collider(0);
    const ballCollider = ball.collider(0);
    car.setLinvel({ x: 0, y: 0, z: generated.approachSpeed }, true);
    ball.setLinvel({ x: 0, y: 0, z: 0 }, true);
    ball.setAngvel({ x: 0, y: 0, z: 0 }, true);

    const maximumBallLinearSpeed = scalarValue(TUNING_IDS.ball.maxLinearSpeed)
      + BALL_LINEAR_SPEED_TOLERANCE;
    const maximumBallAngularSpeed = scalarValue(TUNING_IDS.ball.maxAngularSpeed);
    const collisionTrace: CollisionTraceSample[] = [];
    let contactStep = -1;
    let peakRawBallSpin = 0;
    let peakBoundedBallSpin = 0;
    let peakBallSpeed = 0;
    let peakBallHorizontalSpeed = 0;

    for (let stepIndex = 0; stepIndex < COLLISION_STEP_LIMIT; stepIndex += 1) {
      recoverCarBodyBeforeStep(car);
      recoverBallBeforeStep(ball);
      world.step();

      const contact = readContactImpulse(world, carCollider, ballCollider);
      const rawLinearVelocity = { ...ball.linvel() };
      const rawAngularVelocity = { ...ball.angvel() };
      const rawAngularSpeed = vectorLength(rawAngularVelocity);
      assertFiniteVector(rawLinearVelocity, 'raw Rapier ball linear velocity');
      assertFiniteVector(rawAngularVelocity, 'raw Rapier ball angular velocity');
      if (contact.contactPoints > 0 && contactStep < 0) contactStep = stepIndex;
      peakRawBallSpin = Math.max(peakRawBallSpin, rawAngularSpeed);

      recoverCarBodyAfterStep(car);
      const bounded = recoverBallAfterStep(ball);
      const boundedLinearSpeed = vectorLength(bounded.linearVelocity);
      const boundedAngularSpeed = vectorLength(bounded.angularVelocity);
      assertRecoveryDidNotAddMotion(
        rawLinearVelocity,
        bounded.linearVelocity,
        maximumBallLinearSpeed,
        'ball linear motion',
      );
      assertRecoveryDidNotAddMotion(
        rawAngularVelocity,
        bounded.angularVelocity,
        maximumBallAngularSpeed,
        'ball angular motion',
      );
      peakBallSpeed = Math.max(peakBallSpeed, boundedLinearSpeed);
      const boundedHorizontalSpeed = Math.hypot(
        bounded.linearVelocity.x,
        bounded.linearVelocity.z,
      );
      peakBallHorizontalSpeed = Math.max(
        peakBallHorizontalSpeed,
        boundedHorizontalSpeed,
      );
      peakBoundedBallSpin = Math.max(peakBoundedBallSpin, boundedAngularSpeed);

      if (
        contact.contactPoints > 0
        || boundedHorizontalSpeed > 1e-6
        || boundedAngularSpeed > 1e-6
      ) {
        collisionTrace.push(Object.freeze({
          step: stepIndex,
          contactPoints: contact.contactPoints,
          normalImpulse: canonicalNumber(contact.normalImpulse),
          tangentImpulse: canonicalNumber(contact.tangentImpulse),
          rawBallAngularSpeed: canonicalNumber(rawAngularSpeed),
          boundedBallAngularSpeed: canonicalNumber(boundedAngularSpeed),
          boundedBallLinearSpeed: canonicalNumber(boundedLinearSpeed),
          ballPosition: canonicalVector(bounded.translation),
          ballAngularVelocity: canonicalVector(bounded.angularVelocity),
        }));
      }

      if (contactStep >= 0 && stepIndex >= contactStep + POST_CONTACT_TRACE_STEPS) break;
    }

    assert.ok(
      contactStep >= 0,
      `the generated off-center approach must produce a real contact manifold: ${JSON.stringify(generated)}`,
    );
    assert.ok(
      collisionTrace.some((sample) => sample.contactPoints > 0),
      'the trace must contain a solved Rapier contact manifold',
    );
    assert.ok(
      peakBallHorizontalSpeed > 0.1,
      'the Rapier contact must impart horizontal motion to the ball',
    );
    assert.ok(
      Number.isFinite(peakRawBallSpin) && peakRawBallSpin > 1e-6,
      `off-center Rapier contact must produce nonzero finite spin, received ${peakRawBallSpin}`,
    );
    assert.ok(peakBoundedBallSpin <= maximumBallAngularSpeed + EPSILON);
    assert.ok(peakBallSpeed <= maximumBallLinearSpeed + EPSILON);
    assertNoScriptedBallActuation(scriptedBallActuation);

    const requestedLinearVelocity = {
      x: 70 + generated.approachSpeed,
      y: -35 - generated.carHeight,
      z: 20 + Math.abs(generated.lateralOffset),
    };
    const requestedAngularVelocity = {
      x: 8 + generated.ballLinearDamping,
      y: -7 - generated.carWidth,
      z: 5 + generated.carLength,
    };
    ball.setLinvel(requestedLinearVelocity, true);
    ball.setAngvel(requestedAngularVelocity, true);
    const recovered = recoverBallAfterStep(ball);
    const recoveredLinearSpeed = vectorLength(recovered.linearVelocity);
    const recoveredAngularSpeed = vectorLength(recovered.angularVelocity);
    assert.ok(recoveredLinearSpeed <= maximumBallLinearSpeed + EPSILON);
    assert.ok(recoveredAngularSpeed <= maximumBallAngularSpeed + EPSILON);
    assertDirectionPreserved(
      requestedLinearVelocity,
      recovered.linearVelocity,
      'explicit ball linear cap recovery',
    );
    assertDirectionPreserved(
      requestedAngularVelocity,
      recovered.angularVelocity,
      'explicit ball angular cap recovery',
    );
    assertNoScriptedBallActuation(scriptedBallActuation);

    return Object.freeze({
      seed: generatedCase.seed,
      index: generatedCase.index,
      dimensions: Object.freeze([
        canonicalNumber(generated.carLength),
        canonicalNumber(generated.carWidth),
        canonicalNumber(generated.carHeight),
      ] as const),
      damping: canonicalNumber(generated.ballLinearDamping),
      contactStep,
      peakRawBallSpin: canonicalNumber(peakRawBallSpin),
      peakBoundedBallSpin: canonicalNumber(peakBoundedBallSpin),
      peakBallSpeed: canonicalNumber(peakBallSpeed),
      peakBallHorizontalSpeed: canonicalNumber(peakBallHorizontalSpeed),
      scriptedBallActuation: Object.freeze({ ...scriptedBallActuation }),
      collisionTrace: Object.freeze(collisionTrace),
      recoveredLinearSpeed: canonicalNumber(recoveredLinearSpeed),
      recoveredAngularSpeed: canonicalNumber(recoveredAngularSpeed),
    });
  });
}

function executeConstructionCases(
  cases: readonly GeneratedCase<GeneratedConstructionCase>[],
): readonly ConstructionResultTrace[] {
  const traces: ConstructionResultTrace[] = [];
  assertGeneratedCases(cases, (generated, generatedCase) => {
    traces.push(executeConstructionCase(generated, generatedCase));
  });
  return Object.freeze(traces);
}

function assertResultSequencesEqual(
  actual: readonly ConstructionResultTrace[],
  expected: readonly ConstructionResultTrace[],
  diagnosticCases: readonly GeneratedCase<GeneratedConstructionCase>[],
): void {
  assert.equal(actual.length, diagnosticCases.length);
  assert.equal(expected.length, diagnosticCases.length);
  let index = 0;
  assertGeneratedCases(diagnosticCases, () => {
    assert.deepEqual(actual[index], expected[index]);
    index += 1;
  });
}

function assertFailureCleanupAndDiagnostics(): void {
  const setupCreatedBefore = disposalTracker.created;
  const setupFreedBefore = disposalTracker.freed;
  const throwingTuning: PhysicsTuningSnapshot = {
    get(id: string): TuningEntry | undefined {
      if (id === TUNING_IDS.car.collider.width) {
        throw new Error('synthetic construction setup failure');
      }
      return DEFAULT_TUNING_REGISTRY_SNAPSHOT.get(id);
    },
  };
  assert.throws(
    () => withTrackedWorld(DEFAULT_TUNING_REGISTRY_SNAPSHOT, (world) => {
      createCarBody(world, { x: 0, y: 1, z: 0 }, undefined, throwingTuning);
    }),
    /synthetic construction setup failure/,
  );
  assert.equal(disposalTracker.created - setupCreatedBefore, 1);
  assert.equal(disposalTracker.freed - setupFreedBefore, 1);

  const failureSeed = 'rocket-arena-property-23-cleanup-diagnostic';
  const failureCases = generateCases({
    seed: failureSeed,
    count: 1,
    generate: (_random, index) => ({ index }),
  });
  const assertionCreatedBefore = disposalTracker.created;
  const assertionFreedBefore = disposalTracker.freed;
  assert.throws(
    () => assertGeneratedCases(failureCases, (_value, generatedCase) => {
      withTrackedWorld(DEFAULT_TUNING_REGISTRY_SNAPSHOT, (world) => {
        createCarBody(world, { x: 0, y: 1, z: -2 });
        createBall(world, { x: 0.3, y: 1, z: 0 });
        assert.fail(`synthetic construction assertion failure ${generatedCase.index}`);
      });
    }),
    (error: unknown): boolean => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Generated case failed/);
      assert.ok(error.message.includes(`seed=${JSON.stringify(failureSeed)}`));
      assert.ok(error.message.includes('index=0'));
      assert.ok(error.cause instanceof Error);
      assert.match(error.cause.message, /synthetic construction assertion failure 0/);
      return true;
    },
  );
  assert.equal(disposalTracker.created - assertionCreatedBefore, 1);
  assert.equal(disposalTracker.freed - assertionFreedBefore, 1);
}

/**
 * Feature: rocket-arena, Property 23: Physics construction and collision-owned ball spin
 * **Validates: Requirements 7.1-7.7, 11.1-11.10, 18.7, 18.25-18.26**
 */
test(
  `Property 23: physics construction and collision-owned ball spin (seed=${RECORDED_SEED}, cases=${GENERATED_CASE_COUNT})`,
  async () => {
    await initPhysics();
    const originalCases = generateCases({
      seed: RECORDED_SEED,
      count: GENERATED_CASE_COUNT,
      generate: generateConstructionCase,
    });
    const regeneratedCases = generateCases({
      seed: RECORDED_SEED,
      count: GENERATED_CASE_COUNT,
      generate: generateConstructionCase,
    });
    const replayedCase = replayCase(
      RECORDED_SEED,
      REPLAY_CASE_INDEX,
      generateConstructionCase,
    );
    const replayedCases = Object.freeze([replayedCase]);

    assert.equal(originalCases.length, GENERATED_CASE_COUNT);
    assert.deepEqual(
      originalCases.map(({ index }) => index),
      Array.from({ length: GENERATED_CASE_COUNT }, (_, index) => index),
    );
    assert.deepEqual(originalCases, regeneratedCases);
    assert.deepEqual(replayedCase, originalCases[REPLAY_CASE_INDEX]);
    assert.ok(
      new Set(originalCases.map(({ value }) => value.carLength)).size > 20,
      'length must vary independently across the generated range',
    );
    assert.ok(
      new Set(originalCases.map(({ value }) => value.carWidth)).size > 20,
      'width must vary independently across the generated range',
    );
    assert.ok(
      new Set(originalCases.map(({ value }) => value.carHeight)).size > 20,
      'height must vary independently across the generated range',
    );
    assert.ok(originalCases.some(({ value }) => value.ballLinearDamping === 0));
    assert.ok(originalCases.some(({ value }) => value.ballLinearDamping === 0.2));

    const originalResultTrace = executeConstructionCases(originalCases);
    const regeneratedResultTrace = executeConstructionCases(regeneratedCases);
    const replayedResultTrace = executeConstructionCases(replayedCases);
    assertResultSequencesEqual(
      regeneratedResultTrace,
      originalResultTrace,
      regeneratedCases,
    );
    assertResultSequencesEqual(
      replayedResultTrace,
      Object.freeze([originalResultTrace[REPLAY_CASE_INDEX]!] as const),
      replayedCases,
    );

    assertFailureCleanupAndDiagnostics();
    assert.equal(
      disposalTracker.freed,
      disposalTracker.created,
      'every Property 23 Rapier world must be freed on success or failure',
    );
  },
);
