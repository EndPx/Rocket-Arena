import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ARENA_CEILING_HEIGHT_METERS,
  ARENA_CORNER_CUT_ANGLE_DEGREES,
  ARENA_CORNER_CUT_LENGTH_METERS,
  ARENA_FLOOR_RAMP_HEIGHT_METERS,
  ARENA_GEOMETRY_SPEC,
  ARENA_LENGTH_METERS,
  ARENA_WIDTH_METERS,
  GOAL_DEPTH_METERS,
  GOAL_OPENING_HEIGHT_METERS,
  GOAL_OPENING_WIDTH_METERS,
  InvalidArenaGeometrySpecError,
  isArenaGeometrySpec,
  validateArenaGeometrySpec,
} from '../src/geometry/arena-spec.js';
import { TUNING_IDS } from '../src/tuning/model.js';

function cloneSpec(): Record<string, any> {
  return JSON.parse(JSON.stringify(ARENA_GEOMETRY_SPEC)) as Record<string, any>;
}

function assertFiniteNumbers(value: unknown): void {
  if (typeof value === 'number') {
    assert.equal(Number.isFinite(value), true);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(assertFiniteNumbers);
    return;
  }
  if (typeof value === 'object' && value !== null) {
    Object.values(value).forEach(assertFiniteNumbers);
  }
}

function assertDeepFrozen(value: unknown): void {
  if (typeof value !== 'object' || value === null) return;
  assert.equal(Object.isFrozen(value), true);
  Object.values(value).forEach(assertDeepFrozen);
}

test('metric arena exposes every exact confirmed dimension from one immutable spec', () => {
  assert.equal(ARENA_GEOMETRY_SPEC.width, ARENA_WIDTH_METERS);
  assert.equal(ARENA_GEOMETRY_SPEC.width, 81.92);
  assert.equal(ARENA_GEOMETRY_SPEC.length, ARENA_LENGTH_METERS);
  assert.equal(ARENA_GEOMETRY_SPEC.length, 102.4);
  assert.equal(ARENA_GEOMETRY_SPEC.ceilingHeight, ARENA_CEILING_HEIGHT_METERS);
  assert.equal(ARENA_GEOMETRY_SPEC.ceilingHeight, 20.44);
  assert.equal(ARENA_GEOMETRY_SPEC.cornerCuts.length, 4);
  for (const corner of ARENA_GEOMETRY_SPEC.cornerCuts) {
    assert.equal(corner.horizontalLength, ARENA_CORNER_CUT_LENGTH_METERS);
    assert.equal(corner.horizontalLength, 11.52);
    assert.equal(corner.angleDegrees, ARENA_CORNER_CUT_ANGLE_DEGREES);
    assert.equal(corner.angleDegrees, 45);
  }
  assert.equal(ARENA_GEOMETRY_SPEC.floorWallRamp.height, ARENA_FLOOR_RAMP_HEIGHT_METERS);
  assert.equal(ARENA_GEOMETRY_SPEC.floorWallRamp.height, 2.56);
  assert.equal(ARENA_GEOMETRY_SPEC.goal.openingWidth, GOAL_OPENING_WIDTH_METERS);
  assert.equal(ARENA_GEOMETRY_SPEC.goal.openingWidth, 17.86);
  assert.equal(ARENA_GEOMETRY_SPEC.goal.openingHeight, GOAL_OPENING_HEIGHT_METERS);
  assert.equal(ARENA_GEOMETRY_SPEC.goal.openingHeight, 6.43);
  assert.equal(ARENA_GEOMETRY_SPEC.goal.depth, GOAL_DEPTH_METERS);
  assert.equal(ARENA_GEOMETRY_SPEC.goal.depth, 8.8);
  assertFiniteNumbers(ARENA_GEOMETRY_SPEC);
  assertDeepFrozen(ARENA_GEOMETRY_SPEC);
  assert.doesNotThrow(() => validateArenaGeometrySpec(ARENA_GEOMETRY_SPEC));
  assert.equal(isArenaGeometrySpec(ARENA_GEOMETRY_SPEC), true);
});

test('goal ends and four corner descriptors are exact center mirrors', () => {
  const [blue, orange] = ARENA_GEOMETRY_SPEC.goal.ends;
  assert.ok(blue && orange);
  assert.equal(blue.goalLineZ, -ARENA_GEOMETRY_SPEC.halfLength);
  assert.equal(orange.goalLineZ, ARENA_GEOMETRY_SPEC.halfLength);
  assert.equal(blue.goalLineZ, -orange.goalLineZ);
  assert.equal(blue.backWallZ, -orange.backWallZ);
  assert.deepEqual(blue.opening, orange.opening);
  assert.deepEqual(blue.opening, {
    centerX: 0,
    bottomY: 0,
    width: 17.86,
    height: 6.43,
  });

  const signs = new Set(ARENA_GEOMETRY_SPEC.cornerCuts.map(({ xSign, zSign }) => `${xSign},${zSign}`));
  assert.deepEqual(signs, new Set(['-1,-1', '1,-1', '-1,1', '1,1']));
});

test('semantic surface IDs are unique and close the field plus solid goal interiors', () => {
  const ids = ARENA_GEOMETRY_SPEC.surfaces.map(({ id }) => id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ARENA_GEOMETRY_SPEC.topology.closedCollisionVolume, true);
  assert.equal(ARENA_GEOMETRY_SPEC.topology.solidGoalInteriors, true);
  assert.equal(ARENA_GEOMETRY_SPEC.topology.fieldBoundaryLoopClosed, true);
  assert.equal(ARENA_GEOMETRY_SPEC.topology.goalOpeningsTerminateInsideClosedInteriors, true);
  assert.deepEqual(new Set(ARENA_GEOMETRY_SPEC.topology.boundarySurfaceIds), new Set(ids));

  const coreKinds = new Set(
    ARENA_GEOMETRY_SPEC.surfaces
      .filter(({ capability }) => capability === 'core')
      .map(({ kind }) => kind),
  );
  assert.ok(coreKinds.has('floor'));
  assert.ok(coreKinds.has('floor-wall-ramp'));
  assert.ok(coreKinds.has('goal-floor'));
  assert.ok(coreKinds.has('goal-side-wall'));
  assert.ok(coreKinds.has('goal-roof'));
  assert.ok(coreKinds.has('goal-back-wall'));
  assert.ok(ARENA_GEOMETRY_SPEC.surfaces.some(({ capability }) => capability === 'advanced'));

  for (const surface of ARENA_GEOMETRY_SPEC.surfaces) {
    if (surface.mirroredSurfaceId !== null) {
      const mirror = ARENA_GEOMETRY_SPEC.surfaces.find(({ id }) => id === surface.mirroredSurfaceId);
      assert.equal(mirror?.mirroredSurfaceId, surface.id);
    }
  }
});

test('support, pad, and camera mechanics are registry references rather than arena values', () => {
  const references = ARENA_GEOMETRY_SPEC.registryReferences;
  assert.deepEqual(references.support, [
    TUNING_IDS.support.contactPoints,
    TUNING_IDS.support.rayDistance,
    TUNING_IDS.support.normalAngleThresholdDegrees,
  ]);
  assert.deepEqual(references.boostPads, [
    ...TUNING_IDS.boostPads.largePositions,
    TUNING_IDS.boostPads.largeSensorHalfExtents,
    TUNING_IDS.boostPads.smallSensorHalfExtents,
  ]);
  assert.ok(references.camera.includes(TUNING_IDS.camera.ball.distance));
  assert.ok(references.camera.includes(TUNING_IDS.camera.spring.fieldOfViewDegrees));
  for (const ids of Object.values(references)) {
    assert.ok(ids.every((id) => typeof id === 'string' && id.length > 0));
  }
});

test('structural validation rejects non-finite, non-mirrored, duplicate, and open topology', () => {
  const nonFinite = cloneSpec();
  nonFinite.width = Number.NaN;
  assert.throws(() => validateArenaGeometrySpec(nonFinite), InvalidArenaGeometrySpecError);

  const nonMirrored = cloneSpec();
  nonMirrored.goal.ends[1].backWallZ += 1;
  assert.throws(() => validateArenaGeometrySpec(nonMirrored), InvalidArenaGeometrySpecError);

  const duplicateSurface = cloneSpec();
  duplicateSurface.surfaces[1].id = duplicateSurface.surfaces[0].id;
  assert.throws(() => validateArenaGeometrySpec(duplicateSurface), InvalidArenaGeometrySpecError);

  const openTopology = cloneSpec();
  openTopology.topology.boundarySurfaceIds.pop();
  assert.throws(
    () => validateArenaGeometrySpec(openTopology),
    (error: unknown) => error instanceof InvalidArenaGeometrySpecError
      && error.code === 'open-topology',
  );
  assert.equal(isArenaGeometrySpec(openTopology), false);

  const unknownBoundary = cloneSpec();
  unknownBoundary.topology.boundarySurfaceIds[0] = 'field.unknown';
  assert.throws(
    () => validateArenaGeometrySpec(unknownBoundary),
    (error: unknown) => error instanceof InvalidArenaGeometrySpecError
      && error.code === 'invalid-surface-reference',
  );
});

test('structural validation rejects malformed semantic descriptors and registry references', () => {
  const invalidAxes = cloneSpec();
  invalidAxes.axes.width = 'z';
  assert.throws(() => validateArenaGeometrySpec(invalidAxes), InvalidArenaGeometrySpecError);

  const invalidOrigin = cloneSpec();
  invalidOrigin.center = [0, 1, 0];
  assert.throws(() => validateArenaGeometrySpec(invalidOrigin), InvalidArenaGeometrySpecError);

  const sparseOrigin = cloneSpec();
  sparseOrigin.center = new Array(3);
  assert.throws(() => validateArenaGeometrySpec(sparseOrigin), InvalidArenaGeometrySpecError);

  const invalidOpening = cloneSpec();
  invalidOpening.goal.ends[0].opening.width = 18;
  assert.throws(() => validateArenaGeometrySpec(invalidOpening), InvalidArenaGeometrySpecError);

  const invalidGoalSurface = cloneSpec();
  invalidGoalSurface.goal.ends[0].surfaceIds[0] = 'field.floor';
  assert.throws(() => validateArenaGeometrySpec(invalidGoalSurface), InvalidArenaGeometrySpecError);

  const invalidCornerSurface = cloneSpec();
  invalidCornerSurface.cornerCuts[0].surfaceId = 'field.floor';
  assert.throws(() => validateArenaGeometrySpec(invalidCornerSurface), InvalidArenaGeometrySpecError);

  const invalidSurfaceKind = cloneSpec();
  invalidSurfaceKind.surfaces[0].kind = 'wall';
  assert.throws(() => validateArenaGeometrySpec(invalidSurfaceKind), InvalidArenaGeometrySpecError);

  const bypassedExterior = cloneSpec();
  bypassedExterior.surfaces.at(-1).closesExterior = false;
  bypassedExterior.topology.boundarySurfaceIds.pop();
  assert.throws(() => validateArenaGeometrySpec(bypassedExterior), InvalidArenaGeometrySpecError);

  const unknownRegistryId = cloneSpec();
  unknownRegistryId.registryReferences.camera[0] = 'camera.unregistered.value';
  assert.throws(() => validateArenaGeometrySpec(unknownRegistryId), InvalidArenaGeometrySpecError);
});