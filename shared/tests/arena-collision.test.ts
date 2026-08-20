import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ARENA_COLLISION_GEOMETRY,
  ARENA_FLOOR_WALL_RAMP_RUN_METERS,
  ARENA_GEOMETRY_NUMERIC_PRECISION_DECIMALS,
  ARENA_GEOMETRY_SPEC,
  ARENA_PRIMITIVE_SCHEMA_VERSION,
  ARENA_SHELL_THICKNESS_METERS,
  ARENA_TRANSITION_SEGMENT_COUNT,
  ARENA_WALL_CEILING_TRANSITION_RISE_METERS,
  ARENA_WALL_CEILING_TRANSITION_RUN_METERS,
  RESOLVED_ARENA_GEOMETRY,
  computeArenaGeometryFingerprint,
  resolveArenaGeometry,
  validateResolvedArenaGeometry,
  type ArenaMirrorAxis,
  type ArenaVector3Tuple,
  type ResolvedArenaBoundaryPrimitive,
  type ResolvedArenaGeometry,
} from '../src/geometry/index.js';

const EPSILON = 2e-9;

function assertApproximately(actual: number, expected: number, label: string): void {
  assert.ok(Math.abs(actual - expected) <= EPSILON, `${label}: ${actual} != ${expected}`);
}

function assertFiniteCanonicalNumbers(value: unknown, path = 'geometry'): void {
  if (typeof value === 'number') {
    assert.equal(Number.isFinite(value), true, `${path} must be finite`);
    assert.equal(Object.is(value, -0), false, `${path} must normalize negative zero`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => { assertFiniteCanonicalNumbers(entry, `${path}[${index}]`); });
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      assertFiniteCanonicalNumbers(entry, `${path}.${key}`);
    }
  }
}

function assertDeepFrozen(value: unknown, visited = new WeakSet<object>()): void {
  if (typeof value !== 'object' || value === null || visited.has(value)) return;
  visited.add(value);
  assert.equal(Object.isFrozen(value), true);
  Object.values(value).forEach((entry) => { assertDeepFrozen(entry, visited); });
}

function transformed(point: ArenaVector3Tuple, axes: readonly ArenaMirrorAxis[]): number[] {
  return [
    axes.includes('x') ? -point[0] : point[0],
    point[1],
    axes.includes('z') ? -point[2] : point[2],
  ];
}

function sortedPointKeys(points: readonly (readonly number[])[]): string[] {
  return points.map((point) => point.join(',')).sort();
}

function subtract(left: ArenaVector3Tuple, right: ArenaVector3Tuple): ArenaVector3Tuple {
  return [left[0] - right[0], left[1] - right[1], left[2] - right[2]];
}

function cross(left: ArenaVector3Tuple, right: ArenaVector3Tuple): ArenaVector3Tuple {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ];
}

function dot(left: ArenaVector3Tuple, right: ArenaVector3Tuple): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function primitiveById(id: string): ResolvedArenaBoundaryPrimitive {
  const primitive = ARENA_COLLISION_GEOMETRY.primitives.find((candidate) => candidate.id === id);
  assert.ok(primitive, `missing primitive ${id}`);
  return primitive;
}

test('one public singleton is deterministic, deeply frozen, finite, and fingerprint-valid', () => {
  const geometry = ARENA_COLLISION_GEOMETRY;
  assert.strictEqual(geometry, RESOLVED_ARENA_GEOMETRY);
  assert.equal(geometry.identity.sourceVersion, ARENA_GEOMETRY_SPEC.version);
  assert.equal(geometry.identity.primitiveSchemaVersion, ARENA_PRIMITIVE_SCHEMA_VERSION);
  assert.match(geometry.identity.fingerprint, /^arena-v1-p1-[0-9a-f]{16}$/);
  assert.equal(geometry.identity.fingerprint, computeArenaGeometryFingerprint(geometry));

  const second = resolveArenaGeometry(ARENA_GEOMETRY_SPEC);
  assert.notStrictEqual(second, geometry);
  assert.deepEqual(second, geometry);
  assert.equal(second.identity.fingerprint, geometry.identity.fingerprint);
  validateResolvedArenaGeometry(geometry);
  validateResolvedArenaGeometry(second);
  assertFiniteCanonicalNumbers(geometry);
  assertDeepFrozen(geometry);
  assert.equal(ARENA_GEOMETRY_NUMERIC_PRECISION_DECIMALS, 10);
});

test('bounds, corners, goals, and equal-angle profile samples preserve the exact metric contract', () => {
  const geometry = ARENA_COLLISION_GEOMETRY;
  assert.equal(geometry.units, 'meters');
  assert.equal(geometry.shellThickness, ARENA_SHELL_THICKNESS_METERS);
  assert.deepEqual(geometry.bounds, {
    min: [-40.96, 0, -51.2],
    max: [40.96, 20.44, 51.2],
  });
  assert.deepEqual(geometry.enclosureBounds, {
    min: [-40.96, 0, -60],
    max: [40.96, 20.44, 60],
  });

  assert.equal(geometry.cornerCuts.length, 4);
  for (const corner of geometry.cornerCuts) {
    assert.equal(corner.axisRetreat, 11.52);
    assert.equal(corner.angleDegrees, 45);
    assertApproximately(corner.segmentLength, 11.52 * Math.SQRT2, `${corner.id} length`);
  }

  const blue = geometry.goals.find(({ id }) => id === 'blue-goal');
  const orange = geometry.goals.find(({ id }) => id === 'orange-goal');
  assert.ok(blue && orange);
  assert.equal(blue.mirroredGoalId, orange.id);
  assert.equal(orange.mirroredGoalId, blue.id);
  assert.deepEqual([blue.goalLineZ, blue.backWallZ], [-51.2, -60]);
  assert.deepEqual([orange.goalLineZ, orange.backWallZ], [51.2, 60]);
  assert.deepEqual(blue.opening, { centerX: 0, bottomY: 0, width: 17.86, height: 6.43 });
  assert.deepEqual(orange.opening, blue.opening);
  assert.deepEqual(blue.bounds, { min: [-8.93, 0, -60], max: [8.93, 6.43, -51.2] });
  assert.deepEqual(orange.bounds, { min: [-8.93, 0, 51.2], max: [8.93, 6.43, 60] });

  const lower = geometry.profiles.floorWall;
  const upper = geometry.profiles.wallCeiling;
  assert.equal(lower.segmentCount, ARENA_TRANSITION_SEGMENT_COUNT);
  assert.equal(upper.segmentCount, ARENA_TRANSITION_SEGMENT_COUNT);
  assert.equal(lower.samples.length, 9);
  assert.equal(upper.samples.length, 9);
  assert.equal(lower.run, ARENA_FLOOR_WALL_RAMP_RUN_METERS);
  assert.equal(lower.rise, 2.56);
  assert.equal(upper.run, ARENA_WALL_CEILING_TRANSITION_RUN_METERS);
  assert.equal(upper.rise, ARENA_WALL_CEILING_TRANSITION_RISE_METERS);
  for (let index = 0; index <= 8; index += 1) {
    const theta = index * Math.PI / 16;
    assertApproximately(lower.samples[index]!.theta, theta, `lower theta ${index}`);
    assertApproximately(lower.samples[index]!.outward, 2.56 * Math.sin(theta), `lower outward ${index}`);
    assertApproximately(lower.samples[index]!.up, 2.56 * (1 - Math.cos(theta)), `lower up ${index}`);
    assertApproximately(upper.samples[index]!.theta, theta, `upper theta ${index}`);
    assertApproximately(upper.samples[index]!.inward, 2.56 * (1 - Math.cos(theta)), `upper inward ${index}`);
    assertApproximately(upper.samples[index]!.up, 2.56 * Math.sin(theta), `upper up ${index}`);
  }
  assert.deepEqual(lower.samples[0], { index: 0, theta: 0, outward: 0, up: 0 });
  assert.deepEqual(lower.samples[8], { index: 8, theta: Math.round((Math.PI / 2) * 1e10) / 1e10, outward: 2.56, up: 2.56 });
  assert.deepEqual(upper.samples[0], { index: 0, theta: 0, inward: 0, up: 0 });
  assert.deepEqual(upper.samples[8], { index: 8, theta: Math.round((Math.PI / 2) * 1e10) / 1e10, inward: 2.56, up: 2.56 });
});

test('primitive and semantic-surface tables are unique, total, indexed, and role-valid', () => {
  const geometry = ARENA_COLLISION_GEOMETRY;
  const primitiveIds = geometry.primitives.map(({ id }) => id);
  const surfaceIds = geometry.surfaces.map(({ id }) => id);
  assert.equal(geometry.primitives.length, 202);
  assert.equal(new Set(primitiveIds).size, primitiveIds.length);
  assert.equal(new Set(surfaceIds).size, surfaceIds.length);
  assert.deepEqual(new Set(surfaceIds), new Set(ARENA_GEOMETRY_SPEC.surfaces.map(({ id }) => id)));
  assert.ok(geometry.primitives.every(({ collision }) => collision.shape === 'convex-hull'));

  const allowedRoles = new Set([
    'field-floor',
    'field-lower-transition',
    'field-containment',
    'field-ceiling',
    'blue-goal',
    'orange-goal',
  ]);
  for (const primitive of geometry.primitives) {
    assert.ok(allowedRoles.has(primitive.materialRole));
    const surface = geometry.surfaces.find(({ id }) => id === primitive.surfaceId);
    assert.ok(surface, `${primitive.id} must reference a known surface`);
    assert.ok(surface.primitiveIds.includes(primitive.id));
    assert.ok(surface.materialRoles.includes(primitive.materialRole));
    assert.equal(primitive.inwardSurface.positions.length, primitive.inwardSurface.normals.length);
    assert.equal(primitive.inwardSurface.positions.length, primitive.inwardSurface.uvs.length);
    assert.equal(primitive.inwardSurface.indices.length % 3, 0);
    assert.ok(primitive.inwardSurface.indices.every((index) => (
      Number.isSafeInteger(index) && index >= 0 && index < primitive.inwardSurface.positions.length
    )));
    assert.equal(primitive.collision.shape, 'convex-hull');
    assert.ok(primitive.collision.vertices.length >= 6);
  }
  for (const surface of geometry.surfaces) {
    assert.ok(surface.primitiveIds.length > 0, `${surface.id} must be represented`);
    assert.ok(surface.materialRoles.length > 0, `${surface.id} must have a material role`);
  }

  for (const prefix of [
    'field.lower.east.segment-',
    'field.lower.corner.blue-east.segment-',
    'field.lower.blue-end.east.segment-',
    'field.upper.east.segment-',
    'field.upper.corner.blue-east.segment-',
    'field.upper.blue-end.segment-',
    'field.goal-jamb.blue.east.segment-',
  ]) {
    assert.equal(primitiveIds.filter((id) => id.startsWith(prefix)).length, 8, prefix);
  }
});

test('all reflected primitives are reciprocal, exact, and have corrected indexed winding', () => {
  const geometry = ARENA_COLLISION_GEOMETRY;
  const byId = new Map(geometry.primitives.map((primitive) => [primitive.id, primitive]));
  for (const primitive of geometry.primitives) {
    for (let index = 0; index < primitive.inwardSurface.indices.length; index += 3) {
      const first = primitive.inwardSurface.positions[primitive.inwardSurface.indices[index]!]!;
      const second = primitive.inwardSurface.positions[primitive.inwardSurface.indices[index + 1]!]!;
      const third = primitive.inwardSurface.positions[primitive.inwardSurface.indices[index + 2]!]!;
      const geometricNormal = cross(subtract(second, first), subtract(third, first));
      const declared = primitive.inwardSurface.normals[primitive.inwardSurface.indices[index]!]!;
      assert.ok(dot(geometricNormal, declared) > 0, `${primitive.id} triangle ${index / 3} winding`);
    }

    if (primitive.mirroredPrimitiveId === null) {
      assert.deepEqual(primitive.mirrorAxes, []);
      assert.ok(primitive.id === 'field.floor.center' || primitive.id === 'field.ceiling.center');
      continue;
    }
    const mirror = byId.get(primitive.mirroredPrimitiveId);
    assert.ok(mirror);
    assert.equal(mirror.mirroredPrimitiveId, primitive.id);
    assert.deepEqual(mirror.mirrorAxes, primitive.mirrorAxes);
    assert.equal(primitive.collision.shape, 'convex-hull');
    assert.equal(mirror.collision.shape, 'convex-hull');
    assert.deepEqual(
      sortedPointKeys(primitive.collision.vertices.map((point) => transformed(point, primitive.mirrorAxes))),
      sortedPointKeys(mirror.collision.vertices),
      `${primitive.id} collision mirror`,
    );
    assert.deepEqual(
      sortedPointKeys(primitive.inwardSurface.positions.map((point) => transformed(point, primitive.mirrorAxes))),
      sortedPointKeys(mirror.inwardSurface.positions),
      `${primitive.id} visible mirror`,
    );
    assert.deepEqual(
      sortedPointKeys(primitive.inwardSurface.normals.map((normal) => transformed(normal, primitive.mirrorAxes))),
      sortedPointKeys(mirror.inwardSurface.normals),
      `${primitive.id} normal mirror`,
    );
    const expectedIndices = [...primitive.inwardSurface.indices];
    if (primitive.mirrorAxes.length % 2 === 1) {
      for (let index = 0; index < expectedIndices.length; index += 3) {
        [expectedIndices[index + 1], expectedIndices[index + 2]] = [
          expectedIndices[index + 2]!, expectedIndices[index + 1]!,
        ];
      }
    }
    assert.deepEqual(mirror.inwardSurface.indices, expectedIndices, `${primitive.id} reflected winding`);
  }
});

test('seams are reciprocal and topology leaves only the two declared goal apertures unmatched', () => {
  const geometry = ARENA_COLLISION_GEOMETRY;
  const seamsById = new Map(geometry.seams.map((seam) => [seam.id, seam]));
  const primitivesById = new Map(geometry.primitives.map((primitive) => [primitive.id, primitive]));
  assert.equal(seamsById.size, geometry.seams.length);
  assert.equal(geometry.seams.length, 76);
  assert.deepEqual(
    new Set(geometry.seams.map(({ kind }) => kind)),
    new Set([
      'floor-lower',
      'lower-profile',
      'lower-wall',
      'wall-upper',
      'upper-profile',
      'upper-ceiling',
      'side-corner',
      'corner-end',
      'goal-jamb',
      'goal-floor',
      'goal-roof',
      'goal-back',
      'goal-aperture',
    ]),
  );

  for (const seam of geometry.seams) {
    const mirror = seamsById.get(seam.mirroredSeamId);
    assert.ok(mirror, `${seam.id} mirror`);
    assert.equal(mirror.mirroredSeamId, seam.id);
    assert.deepEqual(mirror.mirrorAxes, seam.mirrorAxes);
    assert.ok(seam.edges.length > 0);
    for (const edge of seam.edges) {
      assert.equal(edge.endpoints.length, 2);
      assert.ok(edge.primitiveIds.length >= 2);
      for (const primitiveId of edge.primitiveIds) {
        const primitive = primitivesById.get(primitiveId);
        assert.ok(primitive, `${seam.id} references ${primitiveId}`);
        assert.ok(primitive.inwardSurface.seamIds.includes(seam.id));
      }
    }
  }

  const apertures = geometry.seams.filter(({ topology }) => topology === 'goal-aperture');
  assert.deepEqual(apertures.map(({ apertureId }) => apertureId).sort(), ['blue-goal', 'orange-goal']);
  assert.deepEqual(apertures.map(({ id }) => id).sort(), [...geometry.topology.unmatchedSeamIds].sort());
  assert.deepEqual([...geometry.topology.unmatchedApertureIds], ['blue-goal', 'orange-goal']);
  assert.ok(geometry.seams.filter(({ topology }) => topology === 'joined').every(({ apertureId }) => apertureId === null));
});

test('topology validation rejects removed and altered seams after fingerprint refresh', () => {
  const missing = structuredClone(ARENA_COLLISION_GEOMETRY) as ResolvedArenaGeometry;
  for (const seamId of ['seam.lower-profile.east', 'seam.lower-profile.west']) {
    const seam = missing.seams.find(({ id }) => id === seamId);
    assert.ok(seam);
    (seam.edges as ResolvedArenaGeometry['seams'][number]['edges'][number][]).splice(0, 1);
  }
  (missing.identity as { fingerprint: string }).fingerprint = computeArenaGeometryFingerprint(missing);
  assert.throws(
    () => validateResolvedArenaGeometry(missing),
    /boundary segment|seam membership/i,
  );

  const altered = structuredClone(ARENA_COLLISION_GEOMETRY) as ResolvedArenaGeometry;
  const goalFloor = altered.seams.find(({ id }) => id === 'seam.goal-floor.blue');
  assert.ok(goalFloor);
  const primitiveIds = goalFloor.edges[0]!.primitiveIds as string[];
  primitiveIds[1] = 'goal.blue.roof';
  (altered.identity as { fingerprint: string }).fingerprint = computeArenaGeometryFingerprint(altered);
  assert.throws(
    () => validateResolvedArenaGeometry(altered),
    /incidence|endpoints|boundary segment/i,
  );
});

test('collision and inward samples retain exact field, ceiling, corner, mouth, and goal-back extents', () => {
  const floor = primitiveById('field.floor.center');
  const ceiling = primitiveById('field.ceiling.center');
  const eastWall = primitiveById('field.wall.east');
  const blueBack = primitiveById('goal.blue.back');
  const orangeBack = primitiveById('goal.orange.back');
  const orangeRoof = primitiveById('goal.orange.roof');

  assert.ok(floor.inwardSurface.positions.every((point) => point[1] === 0));
  assert.ok(ceiling.inwardSurface.positions.every((point) => point[1] === 20.44));
  assert.ok(eastWall.inwardSurface.positions.every((point) => point[0] === 40.96));
  assert.ok(blueBack.inwardSurface.positions.every((point) => point[2] === -60));
  assert.ok(orangeBack.inwardSurface.positions.every((point) => point[2] === 60));
  assert.ok(orangeRoof.inwardSurface.positions.every((point) => point[1] === 6.43));

  const blueAperture = ARENA_COLLISION_GEOMETRY.seams.find(({ id }) => id === 'seam.goal-aperture.blue');
  const orangeAperture = ARENA_COLLISION_GEOMETRY.seams.find(({ id }) => id === 'seam.goal-aperture.orange');
  assert.ok(blueAperture && orangeAperture);
  const bluePoints = blueAperture.edges.flatMap(({ endpoints }) => endpoints);
  const orangePoints = orangeAperture.edges.flatMap(({ endpoints }) => endpoints);
  assert.deepEqual(new Set(bluePoints.map((point) => point[2])), new Set([-51.2]));
  assert.deepEqual(new Set(orangePoints.map((point) => point[2])), new Set([51.2]));
  assert.equal(Math.min(...bluePoints.map((point) => point[0])), -8.93);
  assert.equal(Math.max(...bluePoints.map((point) => point[0])), 8.93);
  assert.equal(Math.min(...bluePoints.map((point) => point[1])), 0);
  assert.equal(Math.max(...bluePoints.map((point) => point[1])), 6.43);
});

test('fingerprint is mutation-sensitive and validation rejects altered descriptors', () => {
  const clone = structuredClone(ARENA_COLLISION_GEOMETRY) as ResolvedArenaGeometry;
  const primitive = clone.primitives[0]!;
  assert.equal(primitive.collision.shape, 'convex-hull');
  const mutableVertex = primitive.collision.vertices[0] as unknown as number[];
  mutableVertex[0] += 0.01;
  const changed = computeArenaGeometryFingerprint(clone);
  assert.notEqual(changed, ARENA_COLLISION_GEOMETRY.identity.fingerprint);
  assert.throws(() => validateResolvedArenaGeometry(clone), /fingerprint|mirror|seam/i);

  const malformed = JSON.parse(JSON.stringify(ARENA_GEOMETRY_SPEC)) as Record<string, unknown>;
  malformed.width = 40;
  assert.throws(() => resolveArenaGeometry(malformed));
});
