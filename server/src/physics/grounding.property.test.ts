import assert from 'node:assert/strict';
import test from 'node:test';
import RAPIER from '@dimforge/rapier3d-compat';
import {
  ARENA_GEOMETRY_SPEC,
  DEFAULT_TUNING_REGISTRY_SNAPSHOT,
  INPUT_PROTOCOL_VERSION,
  TUNING_IDS,
  getScalarTuningValue,
  type ArenaSurfaceDescriptor,
  type FiniteRange,
  type InputCommandV2,
  type TuningEntry,
  type TuningRegistrySnapshot,
} from '@rocket-arena/shared';
import { createBall } from './ball.js';
import { createCarBody } from './car-body.js';
import {
  createCarJumpAirState,
  planCarControllerCommand,
  type CarControllerPlan,
  type CarJumpAirState,
} from './car-controller.js';
import {
  ADVANCED_SURFACE_GROUNDING_ENABLED,
  ArenaSurfaceRegistry,
  combineGroundingNormals,
  detectGroundSupport,
  projectSurfaceCommand,
  type GroundingQuaternion,
  type GroundingResult,
  type GroundingTuningSnapshot,
  type GroundingVector3,
  type SurfaceRelativeBasis,
} from './grounding.js';
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

// The shared helper intentionally lives outside server/src. Runtime loading
// preserves one deterministic generator without widening server's emit root.
const generatedCasesModuleUrl = new URL(
  '../../../shared/tests/support/generated-cases.ts',
  import.meta.url,
).href;
const {
  assertGeneratedCases,
  generateCases,
  replayCase,
} = await import(generatedCasesModuleUrl) as unknown as GeneratedCasesModule;

const RECORDED_SEED = 'rocket-arena-property-13-grounding-v1';
const GENERATED_CASE_COUNT = 120;
const REPLAY_CASE_INDEX = 91;
const TRACE_PRECISION = 1e8;
const GEOMETRY_EPSILON = 3e-5;
const PLANE_HALF_THICKNESS = 0.025;
const ADJACENT_CATEGORY = 'adjacent-core-surfaces' as const;
const AIRBORNE_RESULT = Object.freeze({
  grounded: false,
  normal: null,
  basis: null,
  acceptedHits: Object.freeze([]),
});

const REJECTION_CATEGORIES = Object.freeze([
  'reject-dynamic-car',
  'reject-dynamic-ball',
  'reject-sensor',
  'reject-disabled-collider',
  'reject-disabled-core-metadata',
  'reject-advanced-surface',
  'reject-untagged-fixed',
  'reject-all-miss',
] as const);
type RejectionCategory = typeof REJECTION_CATEGORIES[number];

const SURFACES_BY_ID = new Map<string, ArenaSurfaceDescriptor>(
  ARENA_GEOMETRY_SPEC.surfaces.map((surface) => [surface.id, surface]),
);
const CORE_SURFACES = Object.freeze(
  ARENA_GEOMETRY_SPEC.surfaces.filter((surface) => surface.capability === 'core'),
);
const CORE_SURFACE_IDS = new Set(CORE_SURFACES.map(({ id }) => id));
const CATEGORY_KEYS = Object.freeze([
  ...CORE_SURFACES.map(({ id }) => id),
  ADJACENT_CATEGORY,
  ...REJECTION_CATEGORIES,
]);

interface GeneratedGroundingCase {
  readonly caseIndex: number;
  readonly category: string;
  readonly rotation: GroundingQuaternion;
  readonly translation: GroundingVector3;
  readonly contactPoints: readonly number[];
  readonly rayDistance: number;
  readonly normalThresholdDegrees: number;
  readonly supportGap: number;
  readonly adjacentLeftDegrees: number;
  readonly adjacentRightDegrees: number;
  readonly commandForward: number;
  readonly commandRight: number;
  readonly throttle: number;
  readonly steer: number;
}

interface CanonicalHitTrace {
  readonly contactPointIndex: number;
  readonly surfaceId: string;
  readonly distance: number;
  readonly point: readonly [number, number, number];
  readonly normal: readonly [number, number, number];
}

interface CanonicalBasisTrace {
  readonly normal: readonly [number, number, number];
  readonly forward: readonly [number, number, number];
  readonly right: readonly [number, number, number];
}

interface ControllerTrace {
  readonly groundedThrottleMagnitude: number;
  readonly groundedGripMagnitude: number;
  readonly groundedSteeringMagnitude: number;
  readonly airborneDeltaMagnitude: number;
  readonly groundedReset: boolean;
  readonly airbornePreservedJumpState: boolean;
}

interface GroundingResultTrace {
  readonly seed: string;
  readonly index: number;
  readonly category: string;
  readonly localDown: readonly [number, number, number];
  readonly classifiedGrounded: boolean;
  readonly normal: readonly [number, number, number] | null;
  readonly basis: CanonicalBasisTrace | null;
  readonly acceptedHits: readonly CanonicalHitTrace[];
  readonly surfaceCommand: readonly [number, number, number] | null;
  readonly directRejectedCandidateObserved: boolean;
  readonly controller: ControllerTrace;
}

interface DisposalTracker {
  created: number;
  freed: number;
}

interface ProbeTransform {
  readonly translation: GroundingVector3;
  readonly rotation: GroundingQuaternion;
  readonly localDown: GroundingVector3;
  readonly localRoof: GroundingVector3;
}

interface RejectionFixture {
  readonly collider: RAPIER.Collider | null;
  readonly directCandidateObserved: boolean;
}

const disposalTracker: DisposalTracker = { created: 0, freed: 0 };

function descriptor(id: string): ArenaSurfaceDescriptor {
  const value = SURFACES_BY_ID.get(id);
  if (value === undefined) throw new TypeError(`Missing arena descriptor ${id}.`);
  return value;
}

function scalarEntry(id: string): Extract<TuningEntry, { kind: 'scalar' }> {
  const entry = DEFAULT_TUNING_REGISTRY_SNAPSHOT.get(id);
  if (entry?.kind !== 'scalar') throw new TypeError(`Expected scalar tuning entry ${id}.`);
  return entry;
}

function vectorEntry(id: string): Extract<TuningEntry, { kind: 'vector' }> {
  const entry = DEFAULT_TUNING_REGISTRY_SNAPSHOT.get(id);
  if (entry?.kind !== 'vector') throw new TypeError(`Expected vector tuning entry ${id}.`);
  return entry;
}

function rounded(value: number): number {
  return Number(value.toFixed(9));
}

function sampleSigned(random: SeededRandom, minimumMagnitude: number, maximumMagnitude: number): number {
  const magnitude = minimumMagnitude
    + (maximumMagnitude - minimumMagnitude) * random.next();
  return rounded((random.next() < 0.5 ? -1 : 1) * magnitude);
}

function add(left: GroundingVector3, right: GroundingVector3): GroundingVector3 {
  return { x: left.x + right.x, y: left.y + right.y, z: left.z + right.z };
}

function subtract(left: GroundingVector3, right: GroundingVector3): GroundingVector3 {
  return { x: left.x - right.x, y: left.y - right.y, z: left.z - right.z };
}

function scale(vector: GroundingVector3, scalar: number): GroundingVector3 {
  return { x: vector.x * scalar, y: vector.y * scalar, z: vector.z * scalar };
}

function dot(left: GroundingVector3, right: GroundingVector3): number {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

function magnitude(vector: GroundingVector3): number {
  return Math.hypot(vector.x, vector.y, vector.z);
}

function normalize(
  vector: GroundingVector3,
  fallback?: GroundingVector3,
): GroundingVector3 {
  const length = magnitude(vector);
  if (!Number.isFinite(length) || length <= 1e-12) {
    if (fallback !== undefined) return { ...fallback };
    throw new TypeError('Property 13 expected a finite nonzero vector.');
  }
  return scale(vector, 1 / length);
}

function normalizeQuaternion(rotation: GroundingQuaternion): GroundingQuaternion {
  const length = Math.hypot(rotation.x, rotation.y, rotation.z, rotation.w);
  assert.ok(Number.isFinite(length) && length > 1e-12, 'quaternion must be normalizable');
  return {
    x: rotation.x / length,
    y: rotation.y / length,
    z: rotation.z / length,
    w: rotation.w / length,
  };
}

function multiplyQuaternions(
  left: GroundingQuaternion,
  right: GroundingQuaternion,
): GroundingQuaternion {
  return normalizeQuaternion({
    x: left.w * right.x + left.x * right.w + left.y * right.z - left.z * right.y,
    y: left.w * right.y - left.x * right.z + left.y * right.w + left.z * right.x,
    z: left.w * right.z + left.x * right.y - left.y * right.x + left.z * right.w,
    w: left.w * right.w - left.x * right.x - left.y * right.y - left.z * right.z,
  });
}

function axisAngle(
  axis: 'x' | 'y' | 'z',
  radians: number,
): GroundingQuaternion {
  const sine = Math.sin(radians / 2);
  return {
    x: axis === 'x' ? sine : 0,
    y: axis === 'y' ? sine : 0,
    z: axis === 'z' ? sine : 0,
    w: Math.cos(radians / 2),
  };
}

function rotateVector(
  rotation: GroundingQuaternion,
  vector: GroundingVector3,
): GroundingVector3 {
  const tx = 2 * (rotation.y * vector.z - rotation.z * vector.y);
  const ty = 2 * (rotation.z * vector.x - rotation.x * vector.z);
  const tz = 2 * (rotation.x * vector.y - rotation.y * vector.x);
  return {
    x: vector.x + rotation.w * tx + (rotation.y * tz - rotation.z * ty),
    y: vector.y + rotation.w * ty + (rotation.z * tx - rotation.x * tz),
    z: vector.z + rotation.w * tz + (rotation.x * ty - rotation.y * tx),
  };
}

function generatedOrientation(random: SeededRandom): GroundingQuaternion {
  const yaw = (random.next() * 2 - 1) * Math.PI;
  const pitch = sampleSigned(random, 12, 48) * Math.PI / 180;
  const roll = sampleSigned(random, 10, 45) * Math.PI / 180;
  return multiplyQuaternions(
    axisAngle('y', yaw),
    multiplyQuaternions(axisAngle('z', roll), axisAngle('x', pitch)),
  );
}

function generateGroundingCase(
  random: SeededRandom,
  index: number,
): GeneratedGroundingCase {
  const cycle = Math.floor(index / CATEGORY_KEYS.length);
  const category = CATEGORY_KEYS[index % CATEGORY_KEYS.length]!;
  const halfWidth = rounded(0.28 + random.next() * 0.08);
  const halfLength = rounded(0.28 + random.next() * 0.18);
  const contactY = -0.18;
  const contactPoints = Object.freeze([
    -halfWidth, contactY, -halfLength,
    halfWidth, contactY, -halfLength,
    -halfWidth, contactY, halfLength,
    halfWidth, contactY, halfLength,
  ]);
  const rayDistance = cycle === 0
    ? 0.05
    : cycle === 1
      ? 1
      : rounded(0.08 + random.next() * 0.82);
  const normalThresholdDegrees = cycle === 0
    ? 20
    : cycle === 1
      ? 90
      : rounded(25 + random.next() * 60);

  return Object.freeze({
    caseIndex: index,
    category,
    rotation: Object.freeze(generatedOrientation(random)),
    translation: Object.freeze({
      x: rounded((random.next() * 2 - 1) * 4),
      y: rounded(2.5 + random.next() * 2),
      z: rounded((random.next() * 2 - 1) * 4),
    }),
    contactPoints,
    rayDistance,
    normalThresholdDegrees,
    supportGap: rounded(rayDistance * (0.45 + random.next() * 0.15)),
    adjacentLeftDegrees: rounded(6 + random.next() * 6),
    adjacentRightDegrees: rounded(10 + random.next() * 6),
    commandForward: rounded(random.next() * 2 - 1),
    commandRight: rounded(random.next() * 2 - 1),
    throttle: sampleSigned(random, 0.25, 1),
    steer: sampleSigned(random, 0.25, 1),
  });
}

function tuningForCase(generated: GeneratedGroundingCase): GroundingTuningSnapshot {
  return {
    get(id: string): TuningEntry | undefined {
      const entry = DEFAULT_TUNING_REGISTRY_SNAPSHOT.get(id);
      if (id === TUNING_IDS.support.contactPoints && entry?.kind === 'vector') {
        return { ...entry, value: generated.contactPoints };
      }
      if (id === TUNING_IDS.support.rayDistance && entry?.kind === 'scalar') {
        return { ...entry, value: generated.rayDistance };
      }
      if (
        id === TUNING_IDS.support.normalAngleThresholdDegrees
        && entry?.kind === 'scalar'
      ) {
        return { ...entry, value: generated.normalThresholdDegrees };
      }
      return entry;
    },
  } satisfies Pick<TuningRegistrySnapshot, 'get'>;
}

function assertInRange(value: number, range: FiniteRange, label: string): void {
  assert.ok(Number.isFinite(value), `${label} must be finite`);
  assert.ok(value >= range.min && value <= range.max, `${label} must be registry-valid`);
}

function assertGeneratedConfiguration(generated: GeneratedGroundingCase): void {
  assert.equal(generated.caseIndex >= 0, true);
  const contactEntry = vectorEntry(TUNING_IDS.support.contactPoints);
  assert.equal(generated.contactPoints.length, 12);
  assert.equal(contactEntry.validatedRange.length, generated.contactPoints.length);
  generated.contactPoints.forEach((value, index) => {
    assertInRange(value, contactEntry.validatedRange[index]!, `contact coordinate ${index}`);
  });
  const distinct = new Set<string>();
  for (let index = 0; index < generated.contactPoints.length; index += 3) {
    distinct.add(
      `${generated.contactPoints[index]},${generated.contactPoints[index + 1]},${generated.contactPoints[index + 2]}`,
    );
  }
  assert.equal(distinct.size, 4, 'each generated footprint must have four distinct points');
  assertInRange(
    generated.rayDistance,
    scalarEntry(TUNING_IDS.support.rayDistance).validatedRange,
    'support ray distance',
  );
  assertInRange(
    generated.normalThresholdDegrees,
    scalarEntry(TUNING_IDS.support.normalAngleThresholdDegrees).validatedRange,
    'normal threshold',
  );
  assert.ok(generated.supportGap > 0 && generated.supportGap < generated.rayDistance);
  assert.ok(generated.adjacentLeftDegrees < generated.normalThresholdDegrees);
  assert.ok(generated.adjacentRightDegrees < generated.normalThresholdDegrees);
}

function withTrackedWorld<T>(callback: (world: RAPIER.World) => T): T {
  const world = createWorld();
  disposalTracker.created += 1;
  try {
    return callback(world);
  } finally {
    try {
      world.free();
    } finally {
      disposalTracker.freed += 1;
    }
  }
}

function copyVector(vector: GroundingVector3): GroundingVector3 {
  return { x: vector.x, y: vector.y, z: vector.z };
}

function copyQuaternion(rotation: GroundingQuaternion): GroundingQuaternion {
  return { x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w };
}

function createProbeTransform(body: RAPIER.RigidBody): ProbeTransform {
  const rotation = normalizeQuaternion(copyQuaternion(body.rotation()));
  const localDown = normalize(
    rotateVector(rotation, { x: 0, y: -1, z: 0 }),
    { x: 0, y: -1, z: 0 },
  );
  return {
    translation: copyVector(body.translation()),
    rotation,
    localDown,
    localRoof: scale(localDown, -1),
  };
}

function pointFromContact(
  transform: ProbeTransform,
  localPoint: GroundingVector3,
): GroundingVector3 {
  return add(transform.translation, rotateVector(transform.rotation, localPoint));
}

function contactPointAt(
  generated: GeneratedGroundingCase,
  index: number,
): GroundingVector3 {
  const offset = index * 3;
  return {
    x: generated.contactPoints[offset]!,
    y: generated.contactPoints[offset + 1]!,
    z: generated.contactPoints[offset + 2]!,
  };
}

function alignedPlanePoint(
  generated: GeneratedGroundingCase,
  transform: ProbeTransform,
): GroundingVector3 {
  const localY = generated.contactPoints[1]!;
  return add(
    pointFromContact(transform, { x: 0, y: localY, z: 0 }),
    scale(transform.localDown, generated.supportGap),
  );
}

function createSupportPlane(
  world: RAPIER.World,
  planePoint: GroundingVector3,
  rotation: GroundingQuaternion,
  halfWidth: number,
  halfLength: number,
  sensor = false,
): RAPIER.Collider {
  const normal = normalize(rotateVector(rotation, { x: 0, y: 1, z: 0 }));
  const center = subtract(planePoint, scale(normal, PLANE_HALF_THICKNESS));
  return world.createCollider(
    RAPIER.ColliderDesc.cuboid(halfWidth, PLANE_HALF_THICKNESS, halfLength)
      .setTranslation(center.x, center.y, center.z)
      .setRotation(rotation)
      .setSensor(sensor),
  );
}

function createAlignedSupportPlane(
  world: RAPIER.World,
  generated: GeneratedGroundingCase,
  transform: ProbeTransform,
  sensor = false,
): RAPIER.Collider {
  return createSupportPlane(
    world,
    alignedPlanePoint(generated, transform),
    transform.rotation,
    0.8,
    0.9,
    sensor,
  );
}

function onlyCollider(body: RAPIER.RigidBody, label: string): RAPIER.Collider {
  assert.equal(body.numColliders(), 1, `${label} must own exactly one collider`);
  const collider = body.collider(0);
  assert.ok(collider, `${label} collider must exist`);
  return collider;
}

function assertApproximately(actual: number, expected: number, label: string): void {
  assert.ok(
    Math.abs(actual - expected) <= GEOMETRY_EPSILON,
    `${label}: ${actual} != ${expected}`,
  );
}

function assertVectorApproximately(
  actual: GroundingVector3,
  expected: GroundingVector3,
  label: string,
): void {
  assertApproximately(actual.x, expected.x, `${label}.x`);
  assertApproximately(actual.y, expected.y, `${label}.y`);
  assertApproximately(actual.z, expected.z, `${label}.z`);
}

function assertFiniteVector(vector: GroundingVector3, label: string): void {
  assert.ok([vector.x, vector.y, vector.z].every(Number.isFinite), `${label} must be finite`);
}

function assertUnitVector(vector: GroundingVector3, label: string): void {
  assertFiniteVector(vector, label);
  assertApproximately(magnitude(vector), 1, `${label} length`);
}

function canonicalNumber(value: number): number {
  assert.ok(Number.isFinite(value), `trace value must be finite: ${value}`);
  const canonical = Math.round(value * TRACE_PRECISION) / TRACE_PRECISION;
  return Object.is(canonical, -0) ? 0 : canonical;
}

function canonicalVector(vector: GroundingVector3): readonly [number, number, number] {
  return Object.freeze([
    canonicalNumber(vector.x),
    canonicalNumber(vector.y),
    canonicalNumber(vector.z),
  ] as const);
}

function canonicalBasis(basis: SurfaceRelativeBasis): CanonicalBasisTrace {
  return Object.freeze({
    normal: canonicalVector(basis.normal),
    forward: canonicalVector(basis.forward),
    right: canonicalVector(basis.right),
  });
}

function canonicalHits(result: GroundingResult): readonly CanonicalHitTrace[] {
  return Object.freeze(result.acceptedHits.map((hit): CanonicalHitTrace => Object.freeze({
    contactPointIndex: hit.contactPointIndex,
    surfaceId: hit.surfaceId,
    distance: canonicalNumber(hit.distance),
    point: canonicalVector(hit.point),
    normal: canonicalVector(hit.normal),
  })));
}

function canonicalResult(result: GroundingResult): Readonly<{
  grounded: boolean;
  normal: readonly [number, number, number] | null;
  basis: CanonicalBasisTrace | null;
  acceptedHits: readonly CanonicalHitTrace[];
}> {
  return Object.freeze({
    grounded: result.grounded,
    normal: result.normal === null ? null : canonicalVector(result.normal),
    basis: result.basis === null ? null : canonicalBasis(result.basis),
    acceptedHits: canonicalHits(result),
  });
}

function assertGroundingGeometry(
  result: GroundingResult,
  generated: GeneratedGroundingCase,
  transform: ProbeTransform,
): GroundingVector3 {
  assert.equal(result.grounded, true);
  assert.ok(result.normal !== null && result.basis !== null);
  assert.equal(result.acceptedHits.length, 4, 'one accepted hit is required per footprint point');
  assert.deepEqual(
    result.acceptedHits.map(({ contactPointIndex }) => contactPointIndex),
    [0, 1, 2, 3],
    'accepted hits must retain contact-point-index order without test canonicalization',
  );
  assert.ok(
    Math.hypot(transform.localDown.x, transform.localDown.z) > 0.1,
    'generated Local_Down must not collapse to world-down',
  );
  assertUnitVector(result.normal, 'confirmed normal');
  assertUnitVector(result.basis.normal, 'basis normal');
  assertUnitVector(result.basis.forward, 'basis forward');
  assertUnitVector(result.basis.right, 'basis right');
  assertApproximately(dot(result.basis.normal, result.basis.forward), 0, 'normal/forward');
  assertApproximately(dot(result.basis.normal, result.basis.right), 0, 'normal/right');
  assertApproximately(dot(result.basis.forward, result.basis.right), 0, 'forward/right');

  const minimumNormalDot = Math.cos(generated.normalThresholdDegrees * Math.PI / 180);
  for (const hit of result.acceptedHits) {
    assert.ok(hit.contactPointIndex >= 0 && hit.contactPointIndex < 4);
    assert.ok(hit.distance >= 0 && hit.distance <= generated.rayDistance + GEOMETRY_EPSILON);
    assertApproximately(hit.distance, generated.supportGap, 'support distance');
    assertUnitVector(hit.normal, `hit ${hit.contactPointIndex} normal`);
    assert.ok(
      dot(hit.normal, transform.localRoof) + GEOMETRY_EPSILON >= minimumNormalDot,
      'accepted normal must satisfy the configured angle threshold',
    );
    const origin = pointFromContact(
      transform,
      contactPointAt(generated, hit.contactPointIndex),
    );
    assertVectorApproximately(
      hit.point,
      add(origin, scale(transform.localDown, hit.distance)),
      `Local_Down reconstruction ${hit.contactPointIndex}`,
    );
  }

  const command = projectSurfaceCommand(
    result.basis,
    generated.commandForward,
    generated.commandRight,
  );
  assertFiniteVector(command, 'surface-relative command');
  assert.ok(magnitude(command) <= 1 + GEOMETRY_EPSILON);
  assertApproximately(dot(command, result.normal), 0, 'surface command tangent projection');
  return command;
}

function finitePlanVectors(plan: CarControllerPlan): readonly GroundingVector3[] {
  return [
    plan.localForward,
    plan.throttleAcceleration,
    plan.boostAcceleration,
    plan.dragAcceleration,
    plan.requestedPropulsionAcceleration,
    plan.requestedPropulsionDeltaVelocity,
    plan.appliedPropulsionDeltaVelocity,
    plan.dragDeltaVelocity,
    plan.lateralGripDeltaVelocity,
    plan.deltaVelocity,
    plan.angularDeltaVelocity,
    plan.projectedVelocity,
    plan.projectedAngularVelocity,
  ];
}

function assertControllerClassification(
  support: GroundingResult,
  airborne: GroundingResult,
  generated: GeneratedGroundingCase,
  transform: ProbeTransform,
): ControllerTrace {
  assert.ok(support.basis !== null);
  assert.deepEqual(airborne, AIRBORNE_RESULT);
  const input: InputCommandV2 = Object.freeze({
    protocolVersion: INPUT_PROTOCOL_VERSION,
    throttle: generated.throttle,
    steer: generated.steer,
    pitch: 0,
    yaw: 0,
    roll: 0,
    jumpHeld: false,
    jumpSequence: 7,
    boostHeld: false,
    powerslideHeld: false,
    cameraToggleSequence: 0,
  });
  const staleAirState: Readonly<CarJumpAirState> = Object.freeze({
    ...createCarJumpAirState(7),
    firstJumpAcceptedAtStep: 1,
    airborneSinceFirstJump: true,
    secondJumpAvailable: false,
  });
  const velocity = add(
    scale(support.basis.forward, 2),
    scale(support.basis.right, 2.5),
  );
  const groundedPlan = planCarControllerCommand(input, {
    observation: {
      rotation: transform.rotation,
      linearVelocity: velocity,
      angularVelocity: { x: 0, y: 0, z: 0 },
      grounded: true,
      surfaceBasis: support.basis,
    },
    availableBoost: 0,
    dragEnabled: false,
    jumpAir: { state: staleAirState, fixedStepIndex: 200 },
  });
  assert.ok(groundedPlan.groundedControl !== null, 'accepted support must enable grounded control');
  assert.ok(groundedPlan.jumpAirControl !== null && groundedPlan.nextJumpAirState !== null);
  assert.equal(groundedPlan.jumpAirControl.event, 'none');
  assert.equal(groundedPlan.nextJumpAirState.firstJumpAcceptedAtStep, null);
  assert.equal(groundedPlan.nextJumpAirState.airborneSinceFirstJump, false);
  assert.equal(groundedPlan.nextJumpAirState.secondJumpAvailable, true);
  const groundedThrottleMagnitude = magnitude(groundedPlan.throttleAcceleration);
  const groundedGripMagnitude = magnitude(groundedPlan.lateralGripDeltaVelocity);
  const groundedSteeringMagnitude = magnitude(groundedPlan.angularDeltaVelocity);
  assert.ok(groundedThrottleMagnitude > 0, 'grounded throttle must remain active');
  assert.ok(groundedGripMagnitude > 0, 'grounded lateral grip must remain active');
  assert.ok(groundedSteeringMagnitude > 0, 'grounded steering must remain active');

  const airbornePlan = planCarControllerCommand(input, {
    observation: {
      rotation: transform.rotation,
      linearVelocity: velocity,
      angularVelocity: { x: 0, y: 0, z: 0 },
      grounded: false,
      surfaceBasis: null,
    },
    availableBoost: 0,
    dragEnabled: false,
    jumpAir: { state: staleAirState, fixedStepIndex: 200 },
  });
  assert.equal(airbornePlan.groundedControl, null);
  assert.ok(airbornePlan.jumpAirControl !== null && airbornePlan.nextJumpAirState !== null);
  assert.equal(airbornePlan.jumpAirControl.event, 'none');
  assert.equal(airbornePlan.nextJumpAirState.firstJumpAcceptedAtStep, 1);
  assert.equal(airbornePlan.nextJumpAirState.airborneSinceFirstJump, true);
  assert.equal(airbornePlan.nextJumpAirState.secondJumpAvailable, false);
  assertApproximately(magnitude(airbornePlan.throttleAcceleration), 0, 'airborne throttle');
  assertApproximately(magnitude(airbornePlan.lateralGripDeltaVelocity), 0, 'airborne grip');
  assertApproximately(magnitude(airbornePlan.angularDeltaVelocity), 0, 'airborne steering');
  assertApproximately(magnitude(airbornePlan.deltaVelocity), 0, 'airborne grounded actuation');

  for (const [index, vector] of [
    ...finitePlanVectors(groundedPlan),
    ...finitePlanVectors(airbornePlan),
  ].entries()) {
    assertFiniteVector(vector, `controller vector ${index}`);
  }

  return Object.freeze({
    groundedThrottleMagnitude: canonicalNumber(groundedThrottleMagnitude),
    groundedGripMagnitude: canonicalNumber(groundedGripMagnitude),
    groundedSteeringMagnitude: canonicalNumber(groundedSteeringMagnitude),
    airborneDeltaMagnitude: canonicalNumber(magnitude(airbornePlan.deltaVelocity)),
    groundedReset: groundedPlan.nextJumpAirState.firstJumpAcceptedAtStep === null,
    airbornePreservedJumpState: airbornePlan.nextJumpAirState.firstJumpAcceptedAtStep === 1,
  });
}

function isRejectionCategory(category: string): category is RejectionCategory {
  return (REJECTION_CATEGORIES as readonly string[]).includes(category);
}

function assertCandidateOnRay(
  world: RAPIER.World,
  probe: RAPIER.RigidBody,
  collider: RAPIER.Collider,
  generated: GeneratedGroundingCase,
  transform: ProbeTransform,
): boolean {
  world.updateSceneQueries();
  const origin = pointFromContact(transform, contactPointAt(generated, 0));
  const hit = world.castRayAndGetNormal(
    new RAPIER.Ray(origin, transform.localDown),
    generated.rayDistance,
    true,
    undefined,
    undefined,
    undefined,
    probe,
    (candidate) => candidate.handle === collider.handle,
  );
  assert.ok(hit !== null, `${generated.category} candidate must lie on a support ray`);
  assert.equal(hit.collider.handle, collider.handle);
  assert.ok(hit.timeOfImpact >= 0 && hit.timeOfImpact <= generated.rayDistance);
  return true;
}

function createRejectionFixture(
  world: RAPIER.World,
  registry: ArenaSurfaceRegistry,
  probe: RAPIER.RigidBody,
  generated: GeneratedGroundingCase,
  transform: ProbeTransform,
): RejectionFixture {
  assert.ok(isRejectionCategory(generated.category));
  const planePoint = alignedPlanePoint(generated, transform);
  let collider: RAPIER.Collider | null = null;

  switch (generated.category) {
    case 'reject-dynamic-car': {
      const halfHeight = getScalarTuningValue(
        DEFAULT_TUNING_REGISTRY_SNAPSHOT,
        TUNING_IDS.car.collider.height,
      ) / 2;
      const body = createCarBody(
        world,
        add(planePoint, scale(transform.localDown, halfHeight)),
        transform.rotation,
      );
      collider = onlyCollider(body, 'dynamic rejection car');
      const metadata = registry.register(collider, descriptor('field.floor'));
      assert.equal(metadata.groundingEnabled, true);
      break;
    }
    case 'reject-dynamic-ball': {
      const radius = getScalarTuningValue(
        DEFAULT_TUNING_REGISTRY_SNAPSHOT,
        TUNING_IDS.ball.radius,
      );
      const origin = pointFromContact(transform, contactPointAt(generated, 0));
      const body = createBall(
        world,
        add(origin, scale(transform.localDown, generated.supportGap + radius)),
      );
      collider = onlyCollider(body, 'dynamic rejection ball');
      registry.register(collider, descriptor('field.floor'));
      break;
    }
    case 'reject-sensor': {
      collider = createAlignedSupportPlane(world, generated, transform, true);
      registry.register(collider, descriptor('field.floor'));
      assert.equal(collider.isSensor(), true);
      break;
    }
    case 'reject-disabled-collider': {
      collider = createAlignedSupportPlane(world, generated, transform);
      registry.register(collider, descriptor('field.floor'));
      const observed = assertCandidateOnRay(
        world,
        probe,
        collider,
        generated,
        transform,
      );
      collider.setEnabled(false);
      world.updateSceneQueries();
      assert.equal(collider.isEnabled(), false);
      return { collider, directCandidateObserved: observed };
    }
    case 'reject-disabled-core-metadata': {
      collider = createAlignedSupportPlane(world, generated, transform);
      const metadata = registry.register(collider, descriptor('field.floor'), false);
      assert.equal(metadata.capability, 'core');
      assert.equal(metadata.groundingEnabled, false);
      break;
    }
    case 'reject-advanced-surface': {
      collider = createAlignedSupportPlane(world, generated, transform);
      const metadata = registry.register(collider, descriptor('field.ceiling'), true);
      assert.equal(metadata.capability, 'advanced');
      assert.equal(metadata.groundingEnabled, false);
      assert.equal(ADVANCED_SURFACE_GROUNDING_ENABLED, false);
      break;
    }
    case 'reject-untagged-fixed': {
      collider = createAlignedSupportPlane(world, generated, transform);
      assert.equal(registry.get(collider), null);
      break;
    }
    case 'reject-all-miss':
      return { collider: null, directCandidateObserved: false };
  }

  assert.ok(collider !== null);
  return {
    collider,
    directCandidateObserved: assertCandidateOnRay(
      world,
      probe,
      collider,
      generated,
      transform,
    ),
  };
}

function createSupportTrace(
  generated: GeneratedGroundingCase,
  generatedCase: GeneratedCase<GeneratedGroundingCase>,
): GroundingResultTrace {
  return withTrackedWorld((world) => {
    assertGeneratedConfiguration(generated);
    const tuning = tuningForCase(generated);
    const registry = new ArenaSurfaceRegistry(world);
    const probe = createCarBody(world, generated.translation, generated.rotation);
    const transform = createProbeTransform(probe);
    const colliders: RAPIER.Collider[] = [];
    let expectedNormal: GroundingVector3;

    if (generated.category === ADJACENT_CATEGORY) {
      const halfWidth = Math.abs(generated.contactPoints[0]!);
      const localY = generated.contactPoints[1]!;
      const leftRotation = multiplyQuaternions(
        transform.rotation,
        axisAngle('z', generated.adjacentLeftDegrees * Math.PI / 180),
      );
      const rightRotation = multiplyQuaternions(
        transform.rotation,
        axisAngle('z', -generated.adjacentRightDegrees * Math.PI / 180),
      );
      const leftPoint = add(
        pointFromContact(transform, { x: -halfWidth, y: localY, z: 0 }),
        scale(transform.localDown, generated.supportGap),
      );
      const rightPoint = add(
        pointFromContact(transform, { x: halfWidth, y: localY, z: 0 }),
        scale(transform.localDown, generated.supportGap),
      );
      const planeHalfLength = Math.abs(generated.contactPoints[2]!) + 0.1;
      const left = createSupportPlane(
        world,
        leftPoint,
        leftRotation,
        0.1,
        planeHalfLength,
      );
      const right = createSupportPlane(
        world,
        rightPoint,
        rightRotation,
        0.1,
        planeHalfLength,
      );
      colliders.push(left, right);
      registry.register(left, descriptor('field.floor'));
      registry.register(right, descriptor('goal.blue.floor'));
      const leftNormal = normalize(rotateVector(leftRotation, { x: 0, y: 1, z: 0 }));
      const rightNormal = normalize(rotateVector(rightRotation, { x: 0, y: 1, z: 0 }));
      assert.ok(magnitude(subtract(leftNormal, rightNormal)) > 0.1);
      expectedNormal = normalize(add(scale(leftNormal, 2), scale(rightNormal, 2)));
    } else {
      assert.ok(CORE_SURFACE_IDS.has(generated.category));
      const collider = createAlignedSupportPlane(world, generated, transform);
      colliders.push(collider);
      const metadata = registry.register(collider, descriptor(generated.category));
      assert.equal(metadata.capability, 'core');
      assert.equal(metadata.groundingEnabled, true);
      expectedNormal = transform.localRoof;
    }

    world.updateSceneQueries();
    const result = detectGroundSupport(world, probe, registry, { tuning });
    const repeated = detectGroundSupport(world, probe, registry, { tuning });
    assert.deepEqual(canonicalResult(repeated), canonicalResult(result));
    const surfaceCommand = assertGroundingGeometry(result, generated, transform);
    assertVectorApproximately(result.normal!, expectedNormal, 'deterministic combined normal');

    if (generated.category === ADJACENT_CATEGORY) {
      const bySurface = new Map<string, number>();
      for (const hit of result.acceptedHits) {
        bySurface.set(hit.surfaceId, (bySurface.get(hit.surfaceId) ?? 0) + 1);
      }
      assert.deepEqual(
        [...bySurface.entries()].sort(([left], [right]) => left.localeCompare(right)),
        [['field.floor', 2], ['goal.blue.floor', 2]],
      );
    } else {
      assert.ok(result.acceptedHits.every((hit) => hit.surfaceId === generated.category));
    }

    for (const collider of colliders) collider.setEnabled(false);
    world.updateSceneQueries();
    const airborne = detectGroundSupport(world, probe, registry, { tuning });
    const repeatedAirborne = detectGroundSupport(world, probe, registry, { tuning });
    assert.deepEqual(airborne, AIRBORNE_RESULT);
    assert.deepEqual(repeatedAirborne, AIRBORNE_RESULT);
    const controller = assertControllerClassification(result, airborne, generated, transform);

    return Object.freeze({
      seed: generatedCase.seed,
      index: generatedCase.index,
      category: generated.category,
      localDown: canonicalVector(transform.localDown),
      classifiedGrounded: true,
      normal: canonicalVector(result.normal!),
      basis: canonicalBasis(result.basis!),
      acceptedHits: canonicalHits(result),
      surfaceCommand: canonicalVector(surfaceCommand),
      directRejectedCandidateObserved: false,
      controller,
    });
  });
}

function createRejectionTrace(
  generated: GeneratedGroundingCase,
  generatedCase: GeneratedCase<GeneratedGroundingCase>,
): GroundingResultTrace {
  return withTrackedWorld((world) => {
    assertGeneratedConfiguration(generated);
    assert.ok(isRejectionCategory(generated.category));
    const tuning = tuningForCase(generated);
    const registry = new ArenaSurfaceRegistry(world);
    const probe = createCarBody(world, generated.translation, generated.rotation);
    const transform = createProbeTransform(probe);

    const baselineCollider = createAlignedSupportPlane(world, generated, transform);
    registry.register(baselineCollider, descriptor('field.floor'));
    world.updateSceneQueries();
    const baseline = detectGroundSupport(world, probe, registry, { tuning });
    const baselineCommand = assertGroundingGeometry(baseline, generated, transform);
    assert.ok(baseline.acceptedHits.every((hit) => hit.surfaceId === 'field.floor'));
    assertVectorApproximately(baseline.normal!, transform.localRoof, 'baseline normal');

    baselineCollider.setEnabled(false);
    world.updateSceneQueries();
    const fixture = createRejectionFixture(
      world,
      registry,
      probe,
      generated,
      transform,
    );
    world.updateSceneQueries();
    const rejected = detectGroundSupport(world, probe, registry, { tuning });
    const repeatedRejected = detectGroundSupport(world, probe, registry, { tuning });
    assert.deepEqual(rejected, AIRBORNE_RESULT);
    assert.deepEqual(repeatedRejected, AIRBORNE_RESULT);
    assert.equal(
      fixture.directCandidateObserved,
      generated.category !== 'reject-all-miss',
      'every non-miss rejected fixture must first be observable on a direct Rapier ray',
    );
    const controller = assertControllerClassification(
      baseline,
      rejected,
      generated,
      transform,
    );

    return Object.freeze({
      seed: generatedCase.seed,
      index: generatedCase.index,
      category: generated.category,
      localDown: canonicalVector(transform.localDown),
      classifiedGrounded: false,
      normal: canonicalVector(baseline.normal!),
      basis: canonicalBasis(baseline.basis!),
      acceptedHits: Object.freeze([]),
      surfaceCommand: canonicalVector(baselineCommand),
      directRejectedCandidateObserved: fixture.directCandidateObserved,
      controller,
    });
  });
}

function executeGroundingCase(
  generated: GeneratedGroundingCase,
  generatedCase: GeneratedCase<GeneratedGroundingCase>,
): GroundingResultTrace {
  if (isRejectionCategory(generated.category)) {
    return createRejectionTrace(generated, generatedCase);
  }
  return createSupportTrace(generated, generatedCase);
}

function executeGroundingCases(
  cases: readonly GeneratedCase<GeneratedGroundingCase>[],
): readonly GroundingResultTrace[] {
  const traces: GroundingResultTrace[] = [];
  assertGeneratedCases(cases, (generated, generatedCase) => {
    traces.push(executeGroundingCase(generated, generatedCase));
  });
  return Object.freeze(traces);
}

function assertResultSequencesEqual(
  actual: readonly GroundingResultTrace[],
  expected: readonly GroundingResultTrace[],
  diagnosticCases: readonly GeneratedCase<GeneratedGroundingCase>[],
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
  assert.throws(
    () => withTrackedWorld((world) => {
      createCarBody(world, { x: 0, y: 1, z: 0 });
      new ArenaSurfaceRegistry(world);
      throw new Error('synthetic grounding setup failure');
    }),
    /synthetic grounding setup failure/,
  );
  assert.equal(disposalTracker.created - setupCreatedBefore, 1);
  assert.equal(disposalTracker.freed - setupFreedBefore, 1);

  const failureSeed = 'rocket-arena-property-13-cleanup-diagnostic';
  const failureCases = generateCases({
    seed: failureSeed,
    count: 1,
    generate: generateGroundingCase,
  });
  const assertionCreatedBefore = disposalTracker.created;
  const assertionFreedBefore = disposalTracker.freed;
  assert.throws(
    () => assertGeneratedCases(failureCases, (_generated, generatedCase) => {
      withTrackedWorld((world) => {
        const registry = new ArenaSurfaceRegistry(world);
        const probe = createCarBody(world, { x: 0, y: 1, z: 0 });
        const transform = createProbeTransform(probe);
        const generated = failureCases[0]!.value;
        registry.register(
          createAlignedSupportPlane(world, generated, transform),
          descriptor('field.floor'),
        );
        assert.fail(`synthetic grounding assertion failure ${generatedCase.index}`);
      });
    }),
    (error: unknown): boolean => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Generated case failed/);
      assert.ok(error.message.includes(`seed=${JSON.stringify(failureSeed)}`));
      assert.ok(error.message.includes('index=0'));
      assert.ok(error.cause instanceof Error);
      assert.match(error.cause.message, /synthetic grounding assertion failure 0/);
      return true;
    },
  );
  assert.equal(disposalTracker.created - assertionCreatedBefore, 1);
  assert.equal(disposalTracker.freed - assertionFreedBefore, 1);
}

function assertDeterministicNormalFallback(): void {
  const first = Object.freeze({ x: 1, y: 0, z: 0 });
  const opposite = Object.freeze({ x: -1, y: 0, z: 0 });
  assert.deepEqual(
    combineGroundingNormals([first, opposite]),
    first,
    'a cancelling equal-weight sum must retain the first valid sorted normal',
  );

  const firstAfterInvalid = Object.freeze({ x: 0, y: 0, z: -4 });
  assert.deepEqual(
    combineGroundingNormals([
      { x: Number.NaN, y: 0, z: 0 },
      firstAfterInvalid,
      { x: 0, y: 0, z: 2 },
    ]),
    { x: 0, y: 0, z: -1 },
    'invalid candidates must not replace the first valid fallback normal',
  );
  assert.equal(
    combineGroundingNormals([
      { x: 0, y: 0, z: 0 },
      { x: Number.POSITIVE_INFINITY, y: 0, z: 0 },
    ]),
    null,
    'an input without any valid normal must not invent world-up support',
  );
}

/**
 * Feature: rocket-arena, Property 13: Local-down grounding classification
 * **Validates: Requirements 10.1-10.5, 10.11-10.12, 18.19, 18.25-18.26**
 */
test(
  `Property 13: local-down grounding classification (seed=${RECORDED_SEED}, cases=${GENERATED_CASE_COUNT})`,
  async () => {
    await initPhysics();
    assert.equal(CORE_SURFACES.length, 15, 'the canonical v1 spec must expose all 15 Core surfaces');
    assert.equal(CATEGORY_KEYS.length, 24, 'each cycle must cover 24 semantic categories');
    assert.equal(GENERATED_CASE_COUNT % CATEGORY_KEYS.length, 0);
    assert.equal(ADVANCED_SURFACE_GROUNDING_ENABLED, false);
    assertDeterministicNormalFallback();

    const originalCases = generateCases({
      seed: RECORDED_SEED,
      count: GENERATED_CASE_COUNT,
      generate: generateGroundingCase,
    });
    const regeneratedCases = generateCases({
      seed: RECORDED_SEED,
      count: GENERATED_CASE_COUNT,
      generate: generateGroundingCase,
    });
    const replayedCase = replayCase(
      RECORDED_SEED,
      REPLAY_CASE_INDEX,
      generateGroundingCase,
    );
    const replayedCases = Object.freeze([replayedCase]);

    assert.equal(originalCases.length, GENERATED_CASE_COUNT);
    assert.deepEqual(
      originalCases.map(({ index }) => index),
      Array.from({ length: GENERATED_CASE_COUNT }, (_, index) => index),
    );
    assert.deepEqual(originalCases, regeneratedCases);
    assert.deepEqual(replayedCase, originalCases[REPLAY_CASE_INDEX]);

    const categoryCounts = new Map<string, number>();
    for (const { value } of originalCases) {
      categoryCounts.set(value.category, (categoryCounts.get(value.category) ?? 0) + 1);
    }
    for (const category of CATEGORY_KEYS) {
      assert.equal(categoryCounts.get(category), 5, `${category} must occur once per cycle`);
    }
    assert.deepEqual(
      new Set(
        originalCases
          .map(({ value }) => value.category)
          .filter((category) => CORE_SURFACE_IDS.has(category)),
      ),
      CORE_SURFACE_IDS,
    );
    assert.deepEqual(
      new Set(CORE_SURFACES.map(({ kind }) => kind)),
      new Set([
        'floor',
        'floor-wall-ramp',
        'goal-floor',
        'goal-side-wall',
        'goal-roof',
        'goal-back-wall',
      ]),
    );

    const originalResultTrace = executeGroundingCases(originalCases);
    const regeneratedResultTrace = executeGroundingCases(regeneratedCases);
    const replayedResultTrace = executeGroundingCases(replayedCases);
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
      'every Property 13 Rapier world must be freed on success or failure',
    );
  },
);
