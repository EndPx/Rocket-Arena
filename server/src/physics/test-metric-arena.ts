import assert from 'node:assert/strict';
import RAPIER from '@dimforge/rapier3d-compat';
import {
  ARENA_COLLISION_GEOMETRY,
  DEFAULT_TUNING_REGISTRY_SNAPSHOT,
  TUNING_IDS,
  getScalarTuningValue,
  type ArenaVector3Tuple,
  type ResolvedArenaBoundaryPrimitive,
  type ResolvedArenaGoalRegion,
  type ResolvedArenaSeam,
} from '@rocket-arena/shared';
import {
  createArenaColliders,
  type ArenaColliderOwnership,
  type ArenaConstructionStage,
} from './arena.js';
import {
  createBall,
  recoverBallAfterStep,
  recoverBallBeforeStep,
} from './ball.js';
import { createWorld, initPhysics } from './world.js';

const HIGH_SPEED = 60;
const CONTACT_RESPONSE_PROXIMITY = 0.2;
const CONTACT_CLEARANCE_TOLERANCE = 0.005;
const GOAL_CONTAINMENT_TOLERANCE = 0.005;
const TRAJECTORY_FRAMES = 18;
const SEAM_TRAJECTORY_FRAMES = 12;
const REQUIRED_POST_CONTACT_FRAMES = 3;
const SEAM_TANGENTIAL_SPEED = 18;
const SURFACE_REGION_TOLERANCE = 2e-5;
const EPSILON = 1e-7;
const disposalTracker = { created: 0, freed: 0 };

function tuning(id: string): number {
  return getScalarTuningValue(DEFAULT_TUNING_REGISTRY_SNAPSHOT, id);
}

function countColliders(world: RAPIER.World): number {
  let count = 0;
  world.forEachCollider(() => { count += 1; });
  return count;
}

function withTrackedWorld<T>(run: (world: RAPIER.World) => T): T {
  let world: RAPIER.World | null = null;
  try {
    world = createWorld();
    disposalTracker.created += 1;
    return run(world);
  } finally {
    if (world !== null) {
      world.free();
      disposalTracker.freed += 1;
    }
  }
}

function withArena<T>(
  world: RAPIER.World,
  run: (arena: ArenaColliderOwnership) => T,
): T {
  const arena = createArenaColliders(world, ARENA_COLLISION_GEOMETRY);
  try {
    return run(arena);
  } finally {
    arena.dispose();
    assert.equal(arena.isDisposed, true);
    assert.equal(arena.registry.entries().length, 0);
  }
}

function rounded(value: number): number {
  const result = Math.round(value * 1e7) / 1e7;
  return Object.is(result, -0) ? 0 : result;
}

function vector(
  x: number,
  y: number,
  z: number,
): Readonly<{ x: number; y: number; z: number }> {
  return { x, y, z };
}

function add(left: ArenaVector3Tuple, right: ArenaVector3Tuple): ArenaVector3Tuple {
  return [left[0] + right[0], left[1] + right[1], left[2] + right[2]];
}

function subtract(left: ArenaVector3Tuple, right: ArenaVector3Tuple): ArenaVector3Tuple {
  return [left[0] - right[0], left[1] - right[1], left[2] - right[2]];
}

function scale(value: ArenaVector3Tuple, scalar: number): ArenaVector3Tuple {
  return [value[0] * scalar, value[1] * scalar, value[2] * scalar];
}

function dot(left: ArenaVector3Tuple, right: ArenaVector3Tuple): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function cross(left: ArenaVector3Tuple, right: ArenaVector3Tuple): ArenaVector3Tuple {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ];
}

function magnitude(value: ArenaVector3Tuple): number {
  return Math.hypot(...value);
}

function normalize(value: ArenaVector3Tuple): ArenaVector3Tuple {
  const length = magnitude(value);
  assert.ok(length > EPSILON && Number.isFinite(length));
  return [value[0] / length, value[1] / length, value[2] / length];
}

function midpoint(
  endpoints: readonly [ArenaVector3Tuple, ArenaVector3Tuple],
): ArenaVector3Tuple {
  return scale(add(endpoints[0], endpoints[1]), 0.5);
}

function distanceToSegment(
  point: ArenaVector3Tuple,
  endpoints: readonly [ArenaVector3Tuple, ArenaVector3Tuple],
): number {
  const segment = subtract(endpoints[1], endpoints[0]);
  const lengthSquared = dot(segment, segment);
  const parameter = lengthSquared <= EPSILON
    ? 0
    : Math.max(0, Math.min(1, dot(subtract(point, endpoints[0]), segment) / lengthSquared));
  const closest = add(endpoints[0], scale(segment, parameter));
  return magnitude(subtract(point, closest));
}

function colliderVertexKeys(vertices: readonly (readonly number[])[]): string[] {
  return vertices
    .map((vertex) => vertex.map((value) => rounded(Math.fround(value))).join(','))
    .sort();
}

function assertExactColliderProjection(): void {
  withTrackedWorld((world) => {
    const baseline = countColliders(world);
    const arena = createArenaColliders(world, ARENA_COLLISION_GEOMETRY);
    try {
      assert.strictEqual(arena.geometry, ARENA_COLLISION_GEOMETRY);
      assert.equal(arena.geometry.identity.fingerprint, ARENA_COLLISION_GEOMETRY.identity.fingerprint);
      assert.equal(arena.colliders.length, ARENA_COLLISION_GEOMETRY.primitives.length);
      assert.equal(arena.registry.entries().length, ARENA_COLLISION_GEOMETRY.primitives.length);
      assert.equal(countColliders(world), baseline + ARENA_COLLISION_GEOMETRY.primitives.length);

      for (let index = 0; index < arena.colliders.length; index += 1) {
        const collider = arena.colliders[index]!;
        const primitive = ARENA_COLLISION_GEOMETRY.primitives[index]!;
        assert.equal(collider.isSensor(), false, `${primitive.id} must be solid`);
        const metadata = arena.registry.get(collider);
        assert.ok(metadata, `${primitive.id} must have semantic metadata`);
        assert.equal(metadata.surfaceId, primitive.surfaceId);
        const surface = ARENA_COLLISION_GEOMETRY.surfaces.find(({ id }) => id === primitive.surfaceId);
        assert.ok(surface);
        assert.equal(metadata.kind, surface.kind);
        assert.equal(metadata.capability, surface.capability);
        assert.equal(metadata.groundingEnabled, surface.capability === 'core');

        if (primitive.collision.shape === 'convex-hull') {
          assert.equal(collider.shape.type, RAPIER.ShapeType.ConvexPolyhedron, primitive.id);
          const flat = [...(collider.shape as RAPIER.ConvexPolyhedron).vertices];
          const actual: number[][] = [];
          for (let offset = 0; offset < flat.length; offset += 3) {
            actual.push(flat.slice(offset, offset + 3));
          }
          assert.deepEqual(
            colliderVertexKeys(actual),
            colliderVertexKeys(primitive.collision.vertices),
            `${primitive.id} Rapier hull vertices`,
          );
          assert.deepEqual(
            [collider.translation().x, collider.translation().y, collider.translation().z].map(rounded),
            [0, 0, 0],
            `${primitive.id} hull translation`,
          );
        } else {
          assert.equal(collider.shape.type, RAPIER.ShapeType.Cuboid, primitive.id);
          const halfExtents = (collider.shape as RAPIER.Cuboid).halfExtents;
          assert.deepEqual(
            [halfExtents.x, halfExtents.y, halfExtents.z].map(rounded),
            primitive.collision.halfExtents.map(rounded),
            `${primitive.id} cuboid extents`,
          );
        }
      }
    } finally {
      arena.dispose();
      arena.dispose();
      assert.equal(countColliders(world), baseline);
      assert.equal(arena.registry.entries().length, 0);
    }
  });
}

function raySurfaceId(
  world: RAPIER.World,
  arena: ArenaColliderOwnership,
  origin: Readonly<{ x: number; y: number; z: number }>,
  direction: Readonly<{ x: number; y: number; z: number }>,
  length: number,
): string | null {
  const hit = world.castRayAndGetNormal(
    new RAPIER.Ray(origin, direction),
    length,
    true,
    RAPIER.QueryFilterFlags.ONLY_FIXED | RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
  );
  return hit === null ? null : arena.registry.get(hit.collider)?.surfaceId ?? null;
}

function runGoalSweep(
  world: RAPIER.World,
  zDirection: -1 | 1,
  x: number,
  y: number,
  label: string,
): void {
  const goal = ARENA_COLLISION_GEOMETRY.goals.find(({ zDirection: direction }) => direction === zDirection)!;
  const radius = tuning(TUNING_IDS.ball.radius);
  const startZ = goal.goalLineZ - zDirection * 3;
  const ball = createBall(world, { x, y, z: startZ });
  try {
    ball.setLinvel({ x: 0, y: 0, z: zDirection * HIGH_SPEED }, true);
    let entered = false;
    let maximumDepth = 0;
    for (let frame = 0; frame < 130; frame += 1) {
      recoverBallBeforeStep(ball);
      world.step();
      const state = recoverBallAfterStep(ball);
      const position = state.translation;
      const positionTuple: ArenaVector3Tuple = [position.x, position.y, position.z];
      assertSphereAwareResolvedSurfaceClearance(
        positionTuple,
        radius,
        `${label} frame ${frame}`,
      );
      if (zDirection * position.z > zDirection * goal.goalLineZ + radius * 0.1) {
        entered = true;
        maximumDepth = Math.max(maximumDepth, zDirection * (position.z - goal.goalLineZ));
        assertGoalSphereContainment(goal, positionTuple, radius, `${label} frame ${frame}`);
      }
    }
    assert.equal(entered, true, `${label} must enter the exact mouth`);
    assert.ok(maximumDepth > goal.opening.height / 2, `${label} must travel visibly into the tunnel`);
  } finally {
    if (ball.isValid()) world.removeRigidBody(ball);
  }
}

function assertGoalAperturesAndInteriors(): void {
  withTrackedWorld((world) => withArena(world, (arena) => {
    const radius = tuning(TUNING_IDS.ball.radius);
    for (const goal of ARENA_COLLISION_GEOMETRY.goals) {
      const name = goal.defendingTeam;
      const direction = vector(0, 0, goal.zDirection);
      const rayLength = Math.abs(goal.backWallZ) + 2;
      for (const [x, y, label] of [
        [0, goal.opening.height / 2, 'center'],
        [goal.opening.width / 2 - 0.15, goal.opening.height / 2, 'east-adjacent'],
        [-goal.opening.width / 2 + 0.15, goal.opening.height / 2, 'west-adjacent'],
        [0, 0.15, 'floor-adjacent'],
        [0, goal.opening.height - 0.15, 'roof-adjacent'],
      ] as const) {
        assert.equal(
          raySurfaceId(world, arena, vector(x, y, 0), direction, rayLength),
          `goal.${name}.back`,
          `${name} ${label} point ray must pass through the mouth`,
        );
      }
      for (const [x, y, label, allowed] of [
        [goal.opening.width / 2 + 0.15, goal.opening.height / 2, 'outside east jamb', [`field.wall.${name}-end`, `goal.${name}.side-east`]],
        [-goal.opening.width / 2 - 0.15, goal.opening.height / 2, 'outside west jamb', [`field.wall.${name}-end`, `goal.${name}.side-west`]],
        [0, goal.opening.height + 0.15, 'above roof', [`field.wall.${name}-end`, `goal.${name}.roof`]],
      ] as const) {
        const actual = raySurfaceId(world, arena, vector(x, y, 0), direction, rayLength);
        assert.ok(
          allowed.includes(actual as never),
          `${name} ${label} must remain solid, received ${String(actual)}`,
        );
      }

      const centerZ = (goal.goalLineZ + goal.backWallZ) / 2;
      const centerY = goal.opening.height / 2;
      assert.equal(
        raySurfaceId(world, arena, vector(0, centerY, centerZ), vector(-1, 0, 0), goal.opening.width),
        `goal.${name}.side-west`,
      );
      assert.equal(
        raySurfaceId(world, arena, vector(0, centerY, centerZ), vector(1, 0, 0), goal.opening.width),
        `goal.${name}.side-east`,
      );
      assert.equal(
        raySurfaceId(world, arena, vector(0, centerY, centerZ), vector(0, -1, 0), goal.opening.height),
        `goal.${name}.floor`,
      );
      assert.equal(
        raySurfaceId(world, arena, vector(0, centerY, centerZ), vector(0, 1, 0), goal.opening.height),
        `goal.${name}.roof`,
      );
      assert.equal(
        raySurfaceId(world, arena, vector(0, centerY, centerZ), direction, goal.opening.height),
        `goal.${name}.back`,
      );

      runGoalSweep(world, goal.zDirection, 0, Math.max(radius + 0.1, centerY), `${name} centered sweep`);
      runGoalSweep(
        world,
        goal.zDirection,
        goal.opening.width / 2 - radius - 0.08,
        radius + 0.12,
        `${name} boundary-adjacent sweep`,
      );
    }
  }));
}

function primitiveSurfacePlane(
  primitive: ResolvedArenaBoundaryPrimitive,
): Readonly<{ point: ArenaVector3Tuple; normal: ArenaVector3Tuple }> {
  return {
    point: primitive.inwardSurface.positions[0]!,
    normal: primitive.inwardSurface.normals[0]!,
  };
}

function pointOnTriangleRegion(
  point: ArenaVector3Tuple,
  first: ArenaVector3Tuple,
  second: ArenaVector3Tuple,
  third: ArenaVector3Tuple,
): boolean {
  const firstEdge = subtract(second, first);
  const secondEdge = subtract(third, first);
  const relative = subtract(point, first);
  const normal = cross(firstEdge, secondEdge);
  const normalLength = magnitude(normal);
  if (normalLength <= EPSILON
    || Math.abs(dot(relative, normal) / normalLength) > SURFACE_REGION_TOLERANCE) {
    return false;
  }
  const dot00 = dot(secondEdge, secondEdge);
  const dot01 = dot(secondEdge, firstEdge);
  const dot02 = dot(secondEdge, relative);
  const dot11 = dot(firstEdge, firstEdge);
  const dot12 = dot(firstEdge, relative);
  const denominator = dot00 * dot11 - dot01 * dot01;
  if (Math.abs(denominator) <= EPSILON) return false;
  const inverse = 1 / denominator;
  const u = (dot11 * dot02 - dot01 * dot12) * inverse;
  const v = (dot00 * dot12 - dot01 * dot02) * inverse;
  return u >= -SURFACE_REGION_TOLERANCE
    && v >= -SURFACE_REGION_TOLERANCE
    && u + v <= 1 + SURFACE_REGION_TOLERANCE;
}

function closestPointOnTriangle(
  point: ArenaVector3Tuple,
  first: ArenaVector3Tuple,
  second: ArenaVector3Tuple,
  third: ArenaVector3Tuple,
): ArenaVector3Tuple {
  const firstEdge = subtract(second, first);
  const secondEdge = subtract(third, first);
  const fromFirst = subtract(point, first);
  const d1 = dot(firstEdge, fromFirst);
  const d2 = dot(secondEdge, fromFirst);
  if (d1 <= 0 && d2 <= 0) return first;

  const fromSecond = subtract(point, second);
  const d3 = dot(firstEdge, fromSecond);
  const d4 = dot(secondEdge, fromSecond);
  if (d3 >= 0 && d4 <= d3) return second;

  const firstEdgeRegion = d1 * d4 - d3 * d2;
  if (firstEdgeRegion <= 0 && d1 >= 0 && d3 <= 0) {
    return add(first, scale(firstEdge, d1 / (d1 - d3)));
  }

  const fromThird = subtract(point, third);
  const d5 = dot(firstEdge, fromThird);
  const d6 = dot(secondEdge, fromThird);
  if (d6 >= 0 && d5 <= d6) return third;

  const secondEdgeRegion = d5 * d2 - d1 * d6;
  if (secondEdgeRegion <= 0 && d2 >= 0 && d6 <= 0) {
    return add(first, scale(secondEdge, d2 / (d2 - d6)));
  }

  const oppositeEdgeRegion = d3 * d6 - d5 * d4;
  if (oppositeEdgeRegion <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const interpolation = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    return add(second, scale(subtract(third, second), interpolation));
  }

  const inverse = 1 / (oppositeEdgeRegion + secondEdgeRegion + firstEdgeRegion);
  const secondWeight = secondEdgeRegion * inverse;
  const thirdWeight = firstEdgeRegion * inverse;
  return add(first, add(
    scale(firstEdge, secondWeight),
    scale(secondEdge, thirdWeight),
  ));
}

function finiteSurfaceSeparation(
  primitive: ResolvedArenaBoundaryPrimitive,
  position: ArenaVector3Tuple,
): number {
  const { point, normal } = primitiveSurfacePlane(primitive);
  const signedDistance = dot(subtract(position, point), normal);
  const projection = subtract(position, scale(normal, signedDistance));
  const surface = primitive.inwardSurface;
  let minimumDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < surface.indices.length; index += 3) {
    const first = surface.positions[surface.indices[index]!]!;
    const second = surface.positions[surface.indices[index + 1]!]!;
    const third = surface.positions[surface.indices[index + 2]!]!;
    if (pointOnTriangleRegion(projection, first, second, third)) return signedDistance;
    minimumDistance = Math.min(
      minimumDistance,
      magnitude(subtract(position, closestPointOnTriangle(position, first, second, third))),
    );
  }
  return minimumDistance;
}

interface ResolvedSurfaceClearanceSample {
  readonly primitive: ResolvedArenaBoundaryPrimitive;
  readonly clearance: number;
}

function resolvedSurfaceClearances(
  position: ArenaVector3Tuple,
): ResolvedSurfaceClearanceSample[] {
  const samples: ResolvedSurfaceClearanceSample[] = [];
  for (const primitive of ARENA_COLLISION_GEOMETRY.primitives) {
    samples.push({
      primitive,
      clearance: finiteSurfaceSeparation(primitive, position),
    });
  }
  return samples;
}

function assertSphereAwareResolvedSurfaceClearance(
  position: ArenaVector3Tuple,
  radius: number,
  label: string,
): number {
  const samples = resolvedSurfaceClearances(position);
  assert.ok(samples.length > 0, `${label} is outside every resolved surface region`);
  for (const { primitive, clearance } of samples) {
    assert.ok(
      clearance >= radius - CONTACT_CLEARANCE_TOLERANCE,
      `${label} crossed ${primitive.id}: clearance ${clearance}, radius ${radius},`
        + ` position ${JSON.stringify(position)}`,
    );
  }
  return Math.min(...samples.map(({ clearance }) => clearance));
}

function assertGoalSphereContainment(
  goal: ResolvedArenaGoalRegion,
  position: ArenaVector3Tuple,
  radius: number,
  label: string,
): void {
  const clearances = [
    ['goal side', goal.opening.width / 2 - Math.abs(position[0])],
    ['goal floor', position[1] - goal.opening.bottomY],
    ['goal roof', goal.opening.height - position[1]],
    ['goal back', goal.zDirection * (goal.backWallZ - position[2])],
  ] as const;
  for (const [boundary, clearance] of clearances) {
    assert.ok(
      clearance >= radius - GOAL_CONTAINMENT_TOLERANCE,
      `${label} crossed ${boundary}: clearance ${clearance}, radius ${radius}`,
    );
  }
}

function primitiveRegionAnchor(
  primitive: ResolvedArenaBoundaryPrimitive,
): ArenaVector3Tuple {
  if (primitive.region === 'field') {
    return midpoint([
      ARENA_COLLISION_GEOMETRY.bounds.min,
      ARENA_COLLISION_GEOMETRY.bounds.max,
    ]);
  }
  const goal = ARENA_COLLISION_GEOMETRY.goals.find(({ id }) => id === primitive.region);
  assert.ok(goal, `missing region anchor for ${primitive.id}`);
  return midpoint([goal.bounds.min, goal.bounds.max]);
}

function positionInsideResolvedVolumeBounds(position: ArenaVector3Tuple): boolean {
  const insideBounds = (
    minimum: ArenaVector3Tuple,
    maximum: ArenaVector3Tuple,
  ): boolean => position.every((coordinate, axis) => (
    coordinate >= minimum[axis]! - EPSILON && coordinate <= maximum[axis]! + EPSILON
  ));
  if (insideBounds(
    ARENA_COLLISION_GEOMETRY.bounds.min,
    ARENA_COLLISION_GEOMETRY.bounds.max,
  )) {
    return true;
  }
  return ARENA_COLLISION_GEOMETRY.goals.some(({ bounds }) => (
    insideBounds(bounds.min, bounds.max)
  ));
}

function primitiveLaunch(
  primitive: ResolvedArenaBoundaryPrimitive,
  radius: number,
): Readonly<{
  start: ArenaVector3Tuple;
  velocity: ArenaVector3Tuple;
  target: ArenaVector3Tuple;
}> {
  const target = primitiveSurfacePlane(primitive).point;
  const anchor = primitiveRegionAnchor(primitive);
  const inwardDirection = normalize(subtract(anchor, target));
  const maximumDistance = magnitude(subtract(anchor, target));
  const requiredStartClearance = radius + 0.05;
  for (let distance = radius + 0.25; distance <= maximumDistance; distance += 0.125) {
    const start = add(target, scale(inwardDirection, distance));
    const samples = resolvedSurfaceClearances(start);
    if (positionInsideResolvedVolumeBounds(start)
      && samples.length > 0
      && samples.every(({ clearance }) => clearance >= requiredStartClearance)) {
      return {
        start,
        velocity: scale(inwardDirection, -HIGH_SPEED),
        target,
      };
    }
  }
  throw new TypeError(`Could not find a sphere-safe launch point for ${primitive.id}.`);
}

function minimumResolvedSurfaceSeparation(position: ArenaVector3Tuple): number {
  return Math.min(...resolvedSurfaceClearances(position).map(({ clearance }) => clearance));
}

function expectedTargetSeparationAtSphereContact(
  primitive: ResolvedArenaBoundaryPrimitive,
  start: ArenaVector3Tuple,
  target: ArenaVector3Tuple,
  radius: number,
): number {
  let safeParameter = 0;
  let contactParameter = 1;
  for (let iteration = 0; iteration < 48; iteration += 1) {
    const parameter = (safeParameter + contactParameter) / 2;
    const candidate = add(start, scale(subtract(target, start), parameter));
    if (minimumResolvedSurfaceSeparation(candidate) >= radius) safeParameter = parameter;
    else contactParameter = parameter;
  }
  const expectedContact = add(
    start,
    scale(subtract(target, start), contactParameter),
  );
  return finiteSurfaceSeparation(primitive, expectedContact);
}

function runPrimitiveTrajectory(
  world: RAPIER.World,
  primitive: ResolvedArenaBoundaryPrimitive,
): void {
  const radius = tuning(TUNING_IDS.ball.radius);
  const { start, velocity, target } = primitiveLaunch(primitive, radius);
  const frameCount = Math.max(
    TRAJECTORY_FRAMES,
    Math.ceil(
      magnitude(subtract(start, target))
        / (HIGH_SPEED * tuning(TUNING_IDS.physics.fixedStepSeconds)),
    ) + 12,
  );
  const expectedTargetSeparation = expectedTargetSeparationAtSphereContact(
    primitive,
    start,
    target,
    radius,
  );
  const ball = createBall(world, vector(...start));
  let minimumTargetSeparation = Number.POSITIVE_INFINITY;
  let minimumShellSeparation = Number.POSITIVE_INFINITY;
  try {
    ball.setLinvel(vector(...velocity), true);
    for (let frame = 0; frame < frameCount; frame += 1) {
      recoverBallBeforeStep(ball);
      world.step();
      const state = recoverBallAfterStep(ball);
      const position: ArenaVector3Tuple = [
        state.translation.x,
        state.translation.y,
        state.translation.z,
      ];
      assertSphereAwareResolvedSurfaceClearance(
        position,
        radius,
        `${primitive.id} frame ${frame}`,
      );
      const targetSeparation = finiteSurfaceSeparation(primitive, position);
      minimumTargetSeparation = Math.min(minimumTargetSeparation, targetSeparation);
      minimumShellSeparation = Math.min(
        minimumShellSeparation,
        minimumResolvedSurfaceSeparation(position),
      );
    }
    assert.ok(
      minimumShellSeparation <= radius + CONTACT_RESPONSE_PROXIMITY,
      `${primitive.id} trajectory never reached the sphere-eroded shell: ${minimumShellSeparation}`,
    );
    assert.ok(
      minimumTargetSeparation <= expectedTargetSeparation + CONTACT_RESPONSE_PROXIMITY,
      `${primitive.id} trajectory missed its sphere-aware target neighborhood:`
        + ` ${minimumTargetSeparation} > ${expectedTargetSeparation}`,
    );
  } finally {
    if (ball.isValid()) world.removeRigidBody(ball);
  }
}

function seamEdgeIncidentPrimitives(
  seam: ResolvedArenaSeam,
  edge: ResolvedArenaSeam['edges'][number],
): ResolvedArenaBoundaryPrimitive[] {
  return edge.primitiveIds.map((id) => {
    const primitive = ARENA_COLLISION_GEOMETRY.primitives.find((candidate) => candidate.id === id);
    assert.ok(primitive, `${seam.id} missing ${id}`);
    return primitive;
  });
}

function firstSphereContactAlongRay(
  start: ArenaVector3Tuple,
  direction: ArenaVector3Tuple,
  maximumDistance: number,
  radius: number,
): ArenaVector3Tuple | null {
  let previousDistance = 0;
  const sampleCount = 32;
  for (let sample = 1; sample <= sampleCount; sample += 1) {
    const distance = maximumDistance * sample / sampleCount;
    const candidate = add(start, scale(direction, distance));
    if (minimumResolvedSurfaceSeparation(candidate) <= radius) {
      let safeDistance = previousDistance;
      let contactDistance = distance;
      for (let iteration = 0; iteration < 40; iteration += 1) {
        const midpointDistance = (safeDistance + contactDistance) / 2;
        const midpointPosition = add(start, scale(direction, midpointDistance));
        if (minimumResolvedSurfaceSeparation(midpointPosition) > radius) {
          safeDistance = midpointDistance;
        } else {
          contactDistance = midpointDistance;
        }
      }
      return add(start, scale(direction, contactDistance));
    }
    previousDistance = distance;
  }
  return null;
}

interface SeamTrajectoryLaunch {
  readonly start: ArenaVector3Tuple;
  readonly velocity: ArenaVector3Tuple;
  readonly signedTangent: ArenaVector3Tuple;
  readonly tangentSpeed: number;
  readonly edgeLength: number;
  readonly expectedEdgeDistance: number;
  readonly minimumAllowedEdgeDistance: number;
}

function seamTrajectoryLaunch(
  seam: ResolvedArenaSeam,
  edge: ResolvedArenaSeam['edges'][number],
  directionSign: -1 | 1,
  radius: number,
): SeamTrajectoryLaunch {
  const incident = seamEdgeIncidentPrimitives(seam, edge);
  const edgeVector = subtract(edge.endpoints[1], edge.endpoints[0]);
  const edgeLength = magnitude(edgeVector);
  const baseTangent = normalize(edgeVector);
  const signedTangent = scale(baseTangent, directionSign);
  const tangentSpeed = SEAM_TANGENTIAL_SPEED;
  const inwardSpeed = Math.sqrt(HIGH_SPEED ** 2 - tangentSpeed ** 2);
  const edgeCenter = midpoint(edge.endpoints);

  const averageNormal = normalize(incident.reduce<ArenaVector3Tuple>(
    (sum, primitive) => add(sum, primitive.inwardSurface.normals[0]!),
    [0, 0, 0],
  ));
  const sharedRegion = incident.every(({ region }) => region === incident[0]!.region)
    ? incident[0]!.region
    : 'field';
  const regionAnchor = sharedRegion === 'field'
    ? midpoint([ARENA_COLLISION_GEOMETRY.bounds.min, ARENA_COLLISION_GEOMETRY.bounds.max])
    : (() => {
      const goal = ARENA_COLLISION_GEOMETRY.goals.find(({ id }) => id === sharedRegion);
      assert.ok(goal, `${seam.id} has no anchor for ${sharedRegion}`);
      return midpoint([goal.bounds.min, goal.bounds.max]);
    })();
  const anchorDirection = subtract(regionAnchor, edgeCenter);
  const projectedAnchorDirection = subtract(
    anchorDirection,
    scale(baseTangent, dot(anchorDirection, baseTangent)),
  );
  const normalCandidates = [averageNormal];
  if (magnitude(projectedAnchorDirection) > EPSILON) {
    const anchorNormal = normalize(projectedAnchorDirection);
    if (dot(anchorNormal, averageNormal) < 0.9999) normalCandidates.push(anchorNormal);
  }
  const directAnchorNormal = normalize(anchorDirection);
  if (normalCandidates.every((candidate) => dot(candidate, directAnchorNormal) < 0.9999)) {
    normalCandidates.push(directAnchorNormal);
  }

  const anchorToEdge = subtract(edgeCenter, regionAnchor);
  const accessibleContactCenter = firstSphereContactAlongRay(
    regionAnchor,
    normalize(anchorToEdge),
    magnitude(anchorToEdge),
    radius,
  );
  assert.ok(accessibleContactCenter, `${seam.id} anchor path does not reach its edge neighborhood`);

  for (const normal of normalCandidates) {
    const normalProjection = Math.min(...incident.map((primitive) => (
      dot(normal, primitive.inwardSurface.normals[0]!)
    )));
    if (normalProjection <= 0.1) continue;
    const idealContactCenter = add(edgeCenter, scale(normal, radius / normalProjection));
    const contactCenters = [idealContactCenter, accessibleContactCenter];

    for (const contactCenter of contactCenters) {
      for (let approachClearance = 0.75; approachClearance <= 5; approachClearance += 0.25) {
        const normalTravelToContact = approachClearance / normalProjection;
        const tangentCompensation = tangentSpeed * normalTravelToContact / inwardSpeed;
        const start = add(
          add(contactCenter, scale(normal, normalTravelToContact)),
          scale(signedTangent, -tangentCompensation),
        );
        if (!positionInsideResolvedVolumeBounds(start)
          || minimumResolvedSurfaceSeparation(start) < radius + 0.05) {
          continue;
        }

        const velocity = add(
          scale(normal, -inwardSpeed),
          scale(signedTangent, tangentSpeed),
        );
        const launchTangentSpeed = dot(velocity, signedTangent);
        if (launchTangentSpeed <= 1) continue;
        const velocityDirection = scale(velocity, 1 / HIGH_SPEED);
        const expectedContact = firstSphereContactAlongRay(
          start,
          velocityDirection,
          (normalTravelToContact + 0.5) * HIGH_SPEED / inwardSpeed,
          radius,
        );
        if (expectedContact === null) continue;
        return {
          start,
          velocity,
          signedTangent,
          tangentSpeed: launchTangentSpeed,
          edgeLength,
          expectedEdgeDistance: distanceToSegment(expectedContact, edge.endpoints),
          minimumAllowedEdgeDistance: radius,
        };
      }
    }
  }
  throw new TypeError(
    `${seam.id} edge ${JSON.stringify(edge.endpoints)} has no sphere-safe launch`
      + ` for direction ${directionSign}.`,
  );
}

function runSeamEdgeTrajectory(
  world: RAPIER.World,
  seam: ResolvedArenaSeam,
  edge: ResolvedArenaSeam['edges'][number],
  edgeIndex: number,
  directionSign: -1 | 1,
): void {
  const radius = tuning(TUNING_IDS.ball.radius);
  const launch = seamTrajectoryLaunch(seam, edge, directionSign, radius);
  const label = `${seam.id} edge ${edgeIndex} direction ${directionSign}`
    + ` start ${JSON.stringify(launch.start)} velocity ${JSON.stringify(launch.velocity)}`;
  const ball = createBall(world, vector(...launch.start));
  let minimumEdgeDistance = Number.POSITIVE_INFINITY;
  let contactFrame: number | null = null;
  let contactPosition: ArenaVector3Tuple | null = null;
  let preContactTangentVelocity = launch.tangentSpeed;
  const postContactTangentVelocities: number[] = [];
  let maximumPostContactProgress = 0;
  let maximumAbsolutePostContactProgress = 0;
  try {
    ball.setLinvel(vector(...launch.velocity), true);
    for (let frame = 0; frame < SEAM_TRAJECTORY_FRAMES; frame += 1) {
      recoverBallBeforeStep(ball);
      world.step();
      const state = recoverBallAfterStep(ball);
      const position: ArenaVector3Tuple = [
        state.translation.x,
        state.translation.y,
        state.translation.z,
      ];
      const linearVelocity: ArenaVector3Tuple = [
        state.linearVelocity.x,
        state.linearVelocity.y,
        state.linearVelocity.z,
      ];
      assert.ok(
        magnitude(linearVelocity) <= HIGH_SPEED + 0.051,
        `${label} exceeded the configured speed bound at frame ${frame}`,
      );
      const shellSeparation = assertSphereAwareResolvedSurfaceClearance(
        position,
        radius,
        `${label} frame ${frame}`,
      );
      const edgeDistance = distanceToSegment(position, edge.endpoints);
      minimumEdgeDistance = Math.min(minimumEdgeDistance, edgeDistance);
      assert.ok(
        edgeDistance >= launch.minimumAllowedEdgeDistance - CONTACT_CLEARANCE_TOLERANCE,
        `${label} crossed its sphere-eroded edge at frame ${frame}: ${edgeDistance}`,
      );

      const tangentVelocity = dot(linearVelocity, launch.signedTangent);
      if (contactFrame === null) {
        if (edgeDistance <= launch.expectedEdgeDistance + CONTACT_RESPONSE_PROXIMITY
          && shellSeparation <= radius + CONTACT_RESPONSE_PROXIMITY) {
          contactFrame = frame;
          contactPosition = position;
          postContactTangentVelocities.push(tangentVelocity);
        } else {
          preContactTangentVelocity = tangentVelocity;
        }
      } else {
        if (postContactTangentVelocities.length < REQUIRED_POST_CONTACT_FRAMES) {
          postContactTangentVelocities.push(tangentVelocity);
        }
        const postContactProgress = dot(
          subtract(position, contactPosition!),
          launch.signedTangent,
        );
        maximumPostContactProgress = Math.max(
          maximumPostContactProgress,
          postContactProgress,
        );
        maximumAbsolutePostContactProgress = Math.max(
          maximumAbsolutePostContactProgress,
          Math.abs(postContactProgress),
        );
      }
    }

    assert.ok(
      minimumEdgeDistance <= launch.expectedEdgeDistance + CONTACT_RESPONSE_PROXIMITY,
      `${label} missed its sphere-aware edge neighborhood:`
        + ` ${minimumEdgeDistance} > ${launch.expectedEdgeDistance}`,
    );
    assert.notEqual(contactFrame, null, `${label} produced no contact response`);
    assert.ok(
      preContactTangentVelocity >= launch.tangentSpeed * 0.5,
      `${label} lost tangential speed before contact: ${preContactTangentVelocity}`,
    );
    assert.equal(
      postContactTangentVelocities.length,
      REQUIRED_POST_CONTACT_FRAMES,
      `${label} did not record enough post-contact samples`,
    );
    const requiredProgress = Math.min(
      launch.edgeLength * 0.08,
      launch.tangentSpeed * tuning(TUNING_IDS.physics.fixedStepSeconds) * 0.75,
    );
    const directionallyAccessible = launch.edgeLength >= radius * 2 + requiredProgress * 2;
    if (directionallyAccessible) {
      assert.ok(
        postContactTangentVelocities.every((velocity) => velocity >= -launch.tangentSpeed * 0.1),
        `${label} reversed on a directionally accessible edge:`
          + ` ${JSON.stringify(postContactTangentVelocities)}`,
      );
    }
    assert.ok(
      Math.max(...postContactTangentVelocities.map(Math.abs)) >= launch.tangentSpeed * 0.1,
      `${label} lost all post-contact tangential velocity:`
        + ` ${JSON.stringify(postContactTangentVelocities)}`,
    );
    const observedProgress = directionallyAccessible
      ? maximumPostContactProgress
      : maximumAbsolutePostContactProgress;
    assert.ok(
      observedProgress >= requiredProgress,
      `${label} snagged after contact: ${observedProgress} < ${requiredProgress}`,
    );
  } finally {
    if (ball.isValid()) world.removeRigidBody(ball);
  }
}

function assertNoDuplicateInwardFaces(): void {
  const faces = new Map<string, string>();
  for (const primitive of ARENA_COLLISION_GEOMETRY.primitives) {
    const surface = primitive.inwardSurface;
    for (let index = 0; index < surface.indices.length; index += 3) {
      const key = [
        surface.positions[surface.indices[index]!]!,
        surface.positions[surface.indices[index + 1]!]!,
        surface.positions[surface.indices[index + 2]!]!,
      ].map((point) => point.join(',')).sort().join('|');
      const previous = faces.get(key);
      assert.equal(previous, undefined, `duplicate inward face ${primitive.id} / ${previous}`);
      faces.set(key, primitive.id);
    }
  }
}

function assertSphereAwareCcdContainment(): void {
  assertNoDuplicateInwardFaces();
  withTrackedWorld((world) => withArena(world, () => {
    const selected = ARENA_COLLISION_GEOMETRY.primitives;
    assert.equal(selected.length, 202, 'CCD matrix must cover every resolved collision primitive');
    for (const primitive of selected) runPrimitiveTrajectory(world, primitive);

    const joinedSeams = ARENA_COLLISION_GEOMETRY.seams.filter(({ topology }) => topology === 'joined');
    assert.equal(joinedSeams.length, ARENA_COLLISION_GEOMETRY.seams.length - 2);
    let exercisedTrajectories = 0;
    for (const seam of joinedSeams) {
      seam.edges.forEach((edge, edgeIndex) => {
        for (const directionSign of [-1, 1] as const) {
          runSeamEdgeTrajectory(world, seam, edge, edgeIndex, directionSign);
          exercisedTrajectories += 1;
        }
      });
    }
    assert.equal(
      exercisedTrajectories,
      joinedSeams.reduce((count, seam) => count + seam.edges.length * 2, 0),
      'Every joined seam edge must be exercised in both tangent directions',
    );
  }));
}

function sentinelHit(world: RAPIER.World): number | null {
  const hit = world.castRay(
    new RAPIER.Ray({ x: 100, y: 10, z: 0 }, { x: 0, y: -1, z: 0 }),
    20,
    true,
    RAPIER.QueryFilterFlags.ONLY_FIXED,
  );
  return hit?.collider.handle ?? null;
}

function assertRollbackAfterStage(stageToFail: ArenaConstructionStage): void {
  withTrackedWorld((world) => {
    const sentinel = world.createCollider(
      RAPIER.ColliderDesc.cuboid(1, 0.5, 1).setTranslation(100, 0, 0),
    );
    world.updateSceneQueries();
    const baselineCount = countColliders(world);
    const baselineHit = sentinelHit(world);
    assert.equal(baselineHit, sentinel.handle);
    const observedHandles: number[] = [];
    const failure = new Error(`injected-${stageToFail}`);

    assert.throws(
      () => createArenaColliders(world, ARENA_COLLISION_GEOMETRY, {
        afterStage: (context) => {
          if (context.colliderHandle !== null) observedHandles.push(context.colliderHandle);
          const targetIndex = stageToFail === 'scene-query' ? null : 7;
          if (context.stage === stageToFail && context.primitiveIndex === targetIndex) throw failure;
        },
      }),
      (error: unknown) => error === failure,
    );

    assert.equal(countColliders(world), baselineCount, `${stageToFail} rollback collider count`);
    assert.equal(sentinel.isValid(), true);
    assert.equal(sentinelHit(world), baselineHit, `${stageToFail} rollback query state`);
    const survivingHandles = new Set<number>();
    world.forEachCollider((collider) => { survivingHandles.add(collider.handle); });
    assert.ok(observedHandles.every((handle) => !survivingHandles.has(handle)));
  });
}

function assertTransactionalRollbackAndFailureCleanup(): void {
  for (const stage of ['descriptor', 'create', 'register', 'scene-query'] as const) {
    assertRollbackAfterStage(stage);
  }

  const setupFailure = new Error('intentional metric setup failure');
  const freedBeforeSetup = disposalTracker.freed;
  assert.throws(
    () => withTrackedWorld(() => { throw setupFailure; }),
    (error: unknown) => error === setupFailure,
  );
  assert.equal(disposalTracker.freed, freedBeforeSetup + 1);

  const assertionFailure = new assert.AssertionError({ message: 'intentional metric assertion failure' });
  const freedBeforeAssertion = disposalTracker.freed;
  assert.throws(
    () => withTrackedWorld((world) => withArena(world, () => { throw assertionFailure; })),
    (error: unknown) => error === assertionFailure,
  );
  assert.equal(disposalTracker.freed, freedBeforeAssertion + 1);
}

async function main(): Promise<void> {
  await initPhysics();
  assertExactColliderProjection();
  assertGoalAperturesAndInteriors();
  assertSphereAwareCcdContainment();
  assertTransactionalRollbackAndFailureCleanup();
  assert.equal(
    disposalTracker.freed,
    disposalTracker.created,
    `Rapier cleanup mismatch: ${disposalTracker.freed}/${disposalTracker.created}`,
  );
  assert.ok(disposalTracker.created > 0);
  console.log(
    `=== METRIC ARENA HARNESS: PASS (${ARENA_COLLISION_GEOMETRY.primitives.length} primitives,`
    + ` ${ARENA_COLLISION_GEOMETRY.seams.length} seams, cleanup`
    + ` ${disposalTracker.freed}/${disposalTracker.created}) ===`,
  );
}

main().catch((error: unknown) => {
  console.error('=== METRIC ARENA HARNESS: FAIL ===');
  console.error(error);
  process.exitCode = 1;
});
