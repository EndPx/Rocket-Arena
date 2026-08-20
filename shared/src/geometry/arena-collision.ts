import {
  ARENA_GEOMETRY_SPEC,
  validateArenaGeometrySpec,
  type ArenaGeometrySpec,
  type ArenaSurfaceDescriptor,
  type GoalEndDescriptor,
  type SurfaceCapability,
  type SurfaceSemanticKind,
} from './arena-spec.js';

/** Schema for the operational primitive/seam contract, independent of the source spec version. */
export const ARENA_PRIMITIVE_SCHEMA_VERSION = 1 as const;
/** Authoritative values are rounded to this precision before storage and hashing. */
export const ARENA_GEOMETRY_NUMERIC_PRECISION_DECIMALS = 10 as const;
export const ARENA_SHELL_THICKNESS_METERS = 0.5 as const;
export const ARENA_FLOOR_WALL_RAMP_RUN_METERS = 2.56 as const;
export const ARENA_WALL_CEILING_TRANSITION_RUN_METERS = 2.56 as const;
export const ARENA_WALL_CEILING_TRANSITION_RISE_METERS = 2.56 as const;
export const ARENA_TRANSITION_SEGMENT_COUNT = 8 as const;

export type ArenaVector2Tuple = readonly [number, number];
export type ArenaVector3Tuple = readonly [number, number, number];
export type ArenaQuaternionTuple = readonly [number, number, number, number];
export type ArenaRegion = 'field' | 'blue-goal' | 'orange-goal';
export type ArenaPrimitiveSemanticKind =
  | 'floor'
  | 'lower-transition'
  | 'wall'
  | 'corner-cut'
  | 'upper-transition'
  | 'ceiling'
  | 'goal-interior';
export type ArenaBoundaryMaterialRole =
  | 'field-floor'
  | 'field-lower-transition'
  | 'field-containment'
  | 'field-ceiling'
  | 'blue-goal'
  | 'orange-goal';
export type ArenaMirrorAxis = 'x' | 'z';
export type ArenaSeamKind =
  | 'floor-lower'
  | 'lower-profile'
  | 'lower-wall'
  | 'wall-upper'
  | 'upper-profile'
  | 'upper-ceiling'
  | 'side-corner'
  | 'corner-end'
  | 'goal-jamb'
  | 'goal-floor'
  | 'goal-roof'
  | 'goal-back'
  | 'goal-aperture';

export interface ResolvedFloorWallProfileSample {
  readonly index: number;
  readonly theta: number;
  readonly outward: number;
  readonly up: number;
}

export interface ResolvedWallCeilingProfileSample {
  readonly index: number;
  readonly theta: number;
  readonly inward: number;
  readonly up: number;
}

export interface ResolvedFloorWallProfile {
  readonly kind: 'equal-angle-quarter-ellipse';
  readonly run: number;
  readonly rise: number;
  readonly segmentCount: typeof ARENA_TRANSITION_SEGMENT_COUNT;
  readonly samples: readonly ResolvedFloorWallProfileSample[];
}

export interface ResolvedWallCeilingProfile {
  readonly kind: 'equal-angle-quarter-ellipse';
  readonly run: number;
  readonly rise: number;
  readonly segmentCount: typeof ARENA_TRANSITION_SEGMENT_COUNT;
  readonly samples: readonly ResolvedWallCeilingProfileSample[];
}

export interface ResolvedCornerCut {
  readonly id: string;
  readonly surfaceId: string;
  readonly xSign: -1 | 1;
  readonly zSign: -1 | 1;
  readonly axisRetreat: number;
  readonly angleDegrees: number;
  readonly endpoints: readonly [ArenaVector2Tuple, ArenaVector2Tuple];
  readonly segmentLength: number;
}

export interface ResolvedArenaCuboidCollisionDescriptor {
  readonly shape: 'cuboid';
  readonly halfExtents: ArenaVector3Tuple;
  readonly transform: Readonly<{
    readonly translation: ArenaVector3Tuple;
    readonly rotation: ArenaQuaternionTuple;
  }>;
}

export interface ResolvedArenaConvexHullCollisionDescriptor {
  readonly shape: 'convex-hull';
  readonly vertices: readonly ArenaVector3Tuple[];
}

export type ResolvedArenaCollisionDescriptor =
  | ResolvedArenaCuboidCollisionDescriptor
  | ResolvedArenaConvexHullCollisionDescriptor;

export interface ResolvedArenaInwardSurface {
  readonly positions: readonly ArenaVector3Tuple[];
  readonly indices: readonly number[];
  readonly normals: readonly ArenaVector3Tuple[];
  readonly uvs: readonly ArenaVector2Tuple[];
  readonly seamIds: readonly string[];
}

export interface ResolvedArenaBoundaryPrimitive {
  readonly id: string;
  readonly surfaceId: string;
  readonly mirroredPrimitiveId: string | null;
  /** Axes reflected to reach mirroredPrimitiveId; empty only for self-symmetric primitives. */
  readonly mirrorAxes: readonly ArenaMirrorAxis[];
  readonly region: ArenaRegion;
  readonly semanticKind: ArenaPrimitiveSemanticKind;
  readonly collision: ResolvedArenaCollisionDescriptor;
  readonly inwardSurface: ResolvedArenaInwardSurface;
  readonly materialRole: ArenaBoundaryMaterialRole;
}

export interface ResolvedArenaSurface extends ArenaSurfaceDescriptor {
  readonly primitiveIds: readonly string[];
  readonly materialRoles: readonly ArenaBoundaryMaterialRole[];
}

export interface ResolvedArenaGoalRegion {
  readonly id: 'blue-goal' | 'orange-goal';
  readonly defendingTeam: 'blue' | 'orange';
  readonly mirroredGoalId: 'blue-goal' | 'orange-goal';
  readonly zDirection: -1 | 1;
  readonly goalLineZ: number;
  readonly backWallZ: number;
  readonly opening: Readonly<{
    readonly centerX: 0;
    readonly bottomY: 0;
    readonly width: number;
    readonly height: number;
  }>;
  readonly bounds: Readonly<{
    readonly min: ArenaVector3Tuple;
    readonly max: ArenaVector3Tuple;
  }>;
  readonly surfaceIds: readonly string[];
  readonly primitiveIds: readonly string[];
  readonly apertureSeamId: string;
}

export interface ResolvedArenaSeamEdge {
  readonly endpoints: readonly [ArenaVector3Tuple, ArenaVector3Tuple];
  /** Every listed inward surface contains this exact world-space edge. */
  readonly primitiveIds: readonly string[];
}

export interface ResolvedArenaSeam {
  readonly id: string;
  readonly kind: ArenaSeamKind;
  readonly mirroredSeamId: string;
  readonly mirrorAxes: readonly ArenaMirrorAxis[];
  readonly topology: 'joined' | 'goal-aperture';
  readonly apertureId: 'blue-goal' | 'orange-goal' | null;
  readonly edges: readonly ResolvedArenaSeamEdge[];
}

export interface ResolvedArenaGeometry {
  readonly identity: Readonly<{
    readonly sourceVersion: number;
    readonly primitiveSchemaVersion: typeof ARENA_PRIMITIVE_SCHEMA_VERSION;
    readonly fingerprint: string;
  }>;
  readonly units: 'meters';
  readonly shellThickness: number;
  /** Exact field/ceiling bounds; recessed goal extents are recorded in goals. */
  readonly bounds: Readonly<{
    readonly min: ArenaVector3Tuple;
    readonly max: ArenaVector3Tuple;
  }>;
  readonly enclosureBounds: Readonly<{
    readonly min: ArenaVector3Tuple;
    readonly max: ArenaVector3Tuple;
  }>;
  readonly profiles: Readonly<{
    readonly floorWall: ResolvedFloorWallProfile;
    readonly wallCeiling: ResolvedWallCeilingProfile;
  }>;
  readonly cornerCuts: readonly ResolvedCornerCut[];
  readonly goals: readonly ResolvedArenaGoalRegion[];
  readonly surfaces: readonly ResolvedArenaSurface[];
  readonly primitives: readonly ResolvedArenaBoundaryPrimitive[];
  readonly seams: readonly ResolvedArenaSeam[];
  readonly topology: Readonly<{
    readonly closedCollisionVolume: true;
    readonly unmatchedApertureIds: readonly ['blue-goal', 'orange-goal'];
    readonly unmatchedSeamIds: readonly [string, string];
  }>;
}

interface FootprintEdge {
  readonly index: number;
  readonly id: string;
  readonly category: 'side' | 'corner' | 'end';
  readonly surfaceIds: Readonly<{
    readonly lower: string;
    readonly wall: string;
    readonly upper: string;
  }>;
  readonly inward: ArenaVector2Tuple;
}

interface MutablePrimitive {
  id: string;
  surfaceId: string;
  mirroredPrimitiveId: string | null;
  mirrorAxes: ArenaMirrorAxis[];
  region: ArenaRegion;
  semanticKind: ArenaPrimitiveSemanticKind;
  collision: ResolvedArenaCollisionDescriptor;
  inwardSurface: ResolvedArenaInwardSurface;
  materialRole: ArenaBoundaryMaterialRole;
}

interface LowerStripRecord {
  readonly key: string;
  readonly edgeId: string;
  readonly side: 'east' | 'west' | null;
  readonly sampleEdges: readonly (readonly [ArenaVector3Tuple, ArenaVector3Tuple])[];
  readonly primitiveIds: readonly string[];
  readonly surfaceId: string;
  readonly wallId: string;
}

interface UpperStripRecord {
  readonly key: string;
  readonly edgeId: string;
  readonly sampleEdges: readonly (readonly [ArenaVector3Tuple, ArenaVector3Tuple])[];
  readonly primitiveIds: readonly string[];
  readonly surfaceId: string;
}

interface JambRecord {
  readonly goal: 'blue' | 'orange';
  readonly side: 'east' | 'west';
  readonly lowerStrip: LowerStripRecord;
  readonly curvePoints: readonly ArenaVector3Tuple[];
  readonly floorPoints: readonly ArenaVector3Tuple[];
  readonly primitiveIds: readonly string[];
  readonly goalSidePrimitiveId: string;
  readonly floorPrimitiveId: string;
}

interface MutableSeam {
  id: string;
  kind: ArenaSeamKind;
  mirroredSeamId: string;
  mirrorAxes: ArenaMirrorAxis[];
  topology: 'joined' | 'goal-aperture';
  apertureId: 'blue-goal' | 'orange-goal' | null;
  edges: ResolvedArenaSeamEdge[];
}

const EPSILON = 1e-9;
const HASH_PREFIX = `arena-v${ARENA_GEOMETRY_SPEC.version}-p${ARENA_PRIMITIVE_SCHEMA_VERSION}`;

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function canonicalNumber(value: number): number {
  if (!Number.isFinite(value)) throw new TypeError('Resolved arena geometry must contain only finite numbers.');
  const scale = 10 ** ARENA_GEOMETRY_NUMERIC_PRECISION_DECIMALS;
  const rounded = Math.round(value * scale) / scale;
  return Object.is(rounded, -0) || Math.abs(rounded) < 1 / scale ? 0 : rounded;
}

function vector2(x: number, z: number): ArenaVector2Tuple {
  return [canonicalNumber(x), canonicalNumber(z)];
}

function vector3(x: number, y: number, z: number): ArenaVector3Tuple {
  return [canonicalNumber(x), canonicalNumber(y), canonicalNumber(z)];
}

function add3(left: ArenaVector3Tuple, right: ArenaVector3Tuple): ArenaVector3Tuple {
  return vector3(left[0] + right[0], left[1] + right[1], left[2] + right[2]);
}

function subtract3(left: ArenaVector3Tuple, right: ArenaVector3Tuple): ArenaVector3Tuple {
  return vector3(left[0] - right[0], left[1] - right[1], left[2] - right[2]);
}

function scale3(value: ArenaVector3Tuple, scalar: number): ArenaVector3Tuple {
  return vector3(value[0] * scalar, value[1] * scalar, value[2] * scalar);
}

function dot3(left: ArenaVector3Tuple, right: ArenaVector3Tuple): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function cross3(left: ArenaVector3Tuple, right: ArenaVector3Tuple): ArenaVector3Tuple {
  return vector3(
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  );
}

function normalize3(value: ArenaVector3Tuple): ArenaVector3Tuple {
  const length = Math.hypot(...value);
  if (!Number.isFinite(length) || length <= EPSILON) {
    throw new TypeError('Arena surface normals must be finite and non-zero.');
  }
  return vector3(value[0] / length, value[1] / length, value[2] / length);
}

function samePoint(left: ArenaVector3Tuple, right: ArenaVector3Tuple): boolean {
  return Math.abs(left[0] - right[0]) <= EPSILON
    && Math.abs(left[1] - right[1]) <= EPSILON
    && Math.abs(left[2] - right[2]) <= EPSILON;
}

function uniqueBoundary(points: readonly ArenaVector3Tuple[]): ArenaVector3Tuple[] {
  const result: ArenaVector3Tuple[] = [];
  for (const point of points) {
    if (result.length === 0 || !samePoint(result[result.length - 1]!, point)) result.push(point);
  }
  if (result.length > 1 && samePoint(result[0]!, result[result.length - 1]!)) result.pop();
  if (result.length < 3) throw new TypeError('Arena inward polygons require at least three unique points.');
  return result;
}

function surfaceUvs(
  positions: readonly ArenaVector3Tuple[],
  normal: ArenaVector3Tuple,
): readonly ArenaVector2Tuple[] {
  const absolute = normal.map(Math.abs);
  const droppedAxis = absolute[0] >= absolute[1] && absolute[0] >= absolute[2]
    ? 0
    : absolute[1] >= absolute[2] ? 1 : 2;
  const axes = ([0, 1, 2] as const).filter((axis) => axis !== droppedAxis);
  const first = axes[0]!;
  const second = axes[1]!;
  const minimumFirst = Math.min(...positions.map((point) => point[first]));
  const maximumFirst = Math.max(...positions.map((point) => point[first]));
  const minimumSecond = Math.min(...positions.map((point) => point[second]));
  const maximumSecond = Math.max(...positions.map((point) => point[second]));
  const firstSpan = Math.max(maximumFirst - minimumFirst, EPSILON);
  const secondSpan = Math.max(maximumSecond - minimumSecond, EPSILON);
  return positions.map((point) => vector2(
    (point[first] - minimumFirst) / firstSpan,
    (point[second] - minimumSecond) / secondSpan,
  ));
}

function stableAverage(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => Math.abs(left) - Math.abs(right));
  return canonicalNumber(ordered.reduce((sum, value) => sum + value, 0) / ordered.length);
}

function inwardSurface(
  boundaryInput: readonly ArenaVector3Tuple[],
  desiredNormalInput: ArenaVector3Tuple,
): ResolvedArenaInwardSurface {
  const boundary = uniqueBoundary(boundaryInput);
  const desiredNormal = normalize3(desiredNormalInput);
  const centroid = vector3(
    stableAverage(boundary.map((point) => point[0])),
    stableAverage(boundary.map((point) => point[1])),
    stableAverage(boundary.map((point) => point[2])),
  );
  const positions = [centroid, ...boundary];
  const indices: number[] = [];
  for (let index = 0; index < boundary.length; index += 1) {
    const first = index + 1;
    const second = (index + 1) % boundary.length + 1;
    const triangleNormal = cross3(
      subtract3(positions[first]!, positions[0]!),
      subtract3(positions[second]!, positions[0]!),
    );
    if (dot3(triangleNormal, desiredNormal) >= 0) indices.push(0, first, second);
    else indices.push(0, second, first);
  }
  return {
    positions,
    indices,
    normals: positions.map(() => desiredNormal),
    uvs: surfaceUvs(positions, desiredNormal),
    seamIds: [],
  };
}

function prismPrimitive(
  id: string,
  surfaceId: string,
  region: ArenaRegion,
  semanticKind: ArenaPrimitiveSemanticKind,
  materialRole: ArenaBoundaryMaterialRole,
  boundaryInput: readonly ArenaVector3Tuple[],
  desiredNormalInput: ArenaVector3Tuple,
): MutablePrimitive {
  if (id.trim().length === 0 || surfaceId.trim().length === 0) {
    throw new TypeError('Arena primitives require non-empty IDs.');
  }
  const boundary = uniqueBoundary(boundaryInput);
  const desiredNormal = normalize3(desiredNormalInput);
  const outwardOffset = scale3(desiredNormal, -ARENA_SHELL_THICKNESS_METERS);
  const collisionVertices = [
    ...boundary,
    ...boundary.map((point) => add3(point, outwardOffset)),
  ];
  if (new Set(collisionVertices.map((point) => point.join(','))).size < 4) {
    throw new TypeError(`Arena primitive ${id} does not resolve a finite convex volume.`);
  }
  return {
    id,
    surfaceId,
    mirroredPrimitiveId: null,
    mirrorAxes: [],
    region,
    semanticKind,
    collision: { shape: 'convex-hull', vertices: collisionVertices },
    inwardSurface: inwardSurface(boundary, desiredNormal),
    materialRole,
  };
}

function offsetLineIntersection(
  previousStart: ArenaVector2Tuple,
  previousEnd: ArenaVector2Tuple,
  previousNormal: ArenaVector2Tuple,
  currentStart: ArenaVector2Tuple,
  currentEnd: ArenaVector2Tuple,
  currentNormal: ArenaVector2Tuple,
  distance: number,
): ArenaVector2Tuple {
  if (distance === 0) return currentStart;
  const p = vector2(
    previousStart[0] + previousNormal[0] * distance,
    previousStart[1] + previousNormal[1] * distance,
  );
  const q = vector2(
    currentStart[0] + currentNormal[0] * distance,
    currentStart[1] + currentNormal[1] * distance,
  );
  const r = vector2(previousEnd[0] - previousStart[0], previousEnd[1] - previousStart[1]);
  const s = vector2(currentEnd[0] - currentStart[0], currentEnd[1] - currentStart[1]);
  const denominator = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(denominator) <= EPSILON) throw new TypeError('Arena footprint offset lines must intersect.');
  const qMinusP = vector2(q[0] - p[0], q[1] - p[1]);
  const t = (qMinusP[0] * s[1] - qMinusP[1] * s[0]) / denominator;
  return vector2(p[0] + r[0] * t, p[1] + r[1] * t);
}

function canonicalValue(value: unknown): unknown {
  if (typeof value === 'number') return canonicalNumber(value);
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) result[key] = canonicalValue(record[key]);
    return result;
  }
  return value;
}

function fingerprintPayload(geometry: ResolvedArenaGeometry): unknown {
  return {
    identity: {
      sourceVersion: geometry.identity.sourceVersion,
      primitiveSchemaVersion: geometry.identity.primitiveSchemaVersion,
    },
    units: geometry.units,
    shellThickness: geometry.shellThickness,
    bounds: geometry.bounds,
    enclosureBounds: geometry.enclosureBounds,
    profiles: geometry.profiles,
    cornerCuts: geometry.cornerCuts,
    goals: geometry.goals,
    surfaces: geometry.surfaces,
    primitives: geometry.primitives,
    seams: geometry.seams,
    topology: geometry.topology,
  };
}

function hashCanonicalString(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ code, 0x85ebca6b) >>> 0;
    second = (second ^ (second >>> 13)) >>> 0;
  }
  return `${first.toString(16).padStart(8, '0')}${second.toString(16).padStart(8, '0')}`;
}

/** Recompute the browser-safe fingerprint over authoritative descriptor data only. */
export function computeArenaGeometryFingerprint(geometry: ResolvedArenaGeometry): string {
  const serialization = JSON.stringify(canonicalValue(fingerprintPayload(geometry)));
  return `${HASH_PREFIX}-${hashCanonicalString(serialization)}`;
}

function transformedPoint(
  point: ArenaVector3Tuple,
  axes: readonly ArenaMirrorAxis[],
): ArenaVector3Tuple {
  return vector3(
    axes.includes('x') ? -point[0] : point[0],
    point[1],
    axes.includes('z') ? -point[2] : point[2],
  );
}

function sortedPointKeys(points: readonly ArenaVector3Tuple[]): string[] {
  return points.map((point) => point.join(',')).sort();
}

function finiteNumbers(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0);
  if (Array.isArray(value)) return value.every(finiteNumbers);
  if (typeof value === 'object' && value !== null) return Object.values(value).every(finiteNumbers);
  return true;
}

function pointOnTriangle(
  point: ArenaVector3Tuple,
  first: ArenaVector3Tuple,
  second: ArenaVector3Tuple,
  third: ArenaVector3Tuple,
): boolean {
  const v0 = subtract3(third, first);
  const v1 = subtract3(second, first);
  const v2 = subtract3(point, first);
  const normal = cross3(v1, v0);
  const normalLength = Math.hypot(...normal);
  if (normalLength <= EPSILON) return false;
  if (Math.abs(dot3(v2, normal) / normalLength) > 2e-8) return false;
  const dot00 = dot3(v0, v0);
  const dot01 = dot3(v0, v1);
  const dot02 = dot3(v0, v2);
  const dot11 = dot3(v1, v1);
  const dot12 = dot3(v1, v2);
  const denominator = dot00 * dot11 - dot01 * dot01;
  if (Math.abs(denominator) <= EPSILON) return false;
  const inverse = 1 / denominator;
  const u = (dot11 * dot02 - dot01 * dot12) * inverse;
  const v = (dot00 * dot12 - dot01 * dot02) * inverse;
  return u >= -2e-8 && v >= -2e-8 && u + v <= 1 + 2e-8;
}

function surfaceContainsPoint(surface: ResolvedArenaInwardSurface, point: ArenaVector3Tuple): boolean {
  for (let index = 0; index < surface.indices.length; index += 3) {
    const first = surface.positions[surface.indices[index]!]!;
    const second = surface.positions[surface.indices[index + 1]!]!;
    const third = surface.positions[surface.indices[index + 2]!]!;
    if (pointOnTriangle(point, first, second, third)) return true;
  }
  return false;
}

type ArenaEdgeEndpoints = readonly [ArenaVector3Tuple, ArenaVector3Tuple];

function pointKey(point: ArenaVector3Tuple): string {
  return point.join(',');
}

function edgeKey(endpoints: ArenaEdgeEndpoints): string {
  const first = pointKey(endpoints[0]);
  const second = pointKey(endpoints[1]);
  return first < second ? `${first}|${second}` : `${second}|${first}`;
}

function surfaceBoundaryEdges(
  primitive: ResolvedArenaBoundaryPrimitive,
): ArenaEdgeEndpoints[] {
  const indexedEdges = new Map<string, { endpoints: ArenaEdgeEndpoints; count: number }>();
  const surface = primitive.inwardSurface;
  for (let index = 0; index < surface.indices.length; index += 3) {
    const triangle = [
      surface.positions[surface.indices[index]!]!,
      surface.positions[surface.indices[index + 1]!]!,
      surface.positions[surface.indices[index + 2]!]!,
    ] as const;
    for (const [first, second] of [[0, 1], [1, 2], [2, 0]] as const) {
      const endpoints: ArenaEdgeEndpoints = [triangle[first], triangle[second]];
      const key = edgeKey(endpoints);
      const existing = indexedEdges.get(key);
      if (existing === undefined) indexedEdges.set(key, { endpoints, count: 1 });
      else existing.count += 1;
    }
  }
  if ([...indexedEdges.values()].some(({ count }) => count > 2)) {
    throw new TypeError(`Arena primitive ${primitive.id} has non-manifold inward triangulation.`);
  }
  const boundary = [...indexedEdges.values()]
    .filter(({ count }) => count === 1)
    .map(({ endpoints }) => endpoints);
  if (boundary.length < 3) {
    throw new TypeError(`Arena primitive ${primitive.id} has no closed inward boundary.`);
  }
  return boundary;
}

function pointParameterOnSegment(
  point: ArenaVector3Tuple,
  endpoints: ArenaEdgeEndpoints,
): number | null {
  const [start, end] = endpoints;
  const segment = [
    end[0] - start[0],
    end[1] - start[1],
    end[2] - start[2],
  ] as ArenaVector3Tuple;
  const lengthSquared = dot3(segment, segment);
  if (lengthSquared <= EPSILON) return null;
  const relative = [
    point[0] - start[0],
    point[1] - start[1],
    point[2] - start[2],
  ] as ArenaVector3Tuple;
  const parameter = dot3(relative, segment) / lengthSquared;
  if (parameter < -2e-8 || parameter > 1 + 2e-8) return null;
  const closest = [
    start[0] + segment[0] * parameter,
    start[1] + segment[1] * parameter,
    start[2] + segment[2] * parameter,
  ] as ArenaVector3Tuple;
  return Math.hypot(
    point[0] - closest[0],
    point[1] - closest[1],
    point[2] - closest[2],
  ) <= 2e-8 ? parameter : null;
}

function splitEdgeAtPoints(
  endpoints: ArenaEdgeEndpoints,
  splitPoints: readonly ArenaVector3Tuple[],
): ArenaEdgeEndpoints[] {
  const ordered = splitPoints
    .map((point) => ({ point, parameter: pointParameterOnSegment(point, endpoints) }))
    .filter((entry): entry is { point: ArenaVector3Tuple; parameter: number } => (
      entry.parameter !== null
    ))
    .sort((left, right) => left.parameter - right.parameter);
  const unique: typeof ordered = [];
  for (const entry of ordered) {
    if (unique.length === 0
      || Math.abs(entry.parameter - unique[unique.length - 1]!.parameter) > EPSILON) {
      unique.push(entry);
    }
  }
  const result: ArenaEdgeEndpoints[] = [];
  for (let index = 0; index + 1 < unique.length; index += 1) {
    const first = unique[index]!.point;
    const second = unique[index + 1]!.point;
    if (!samePoint(first, second)) result.push([first, second]);
  }
  return result;
}

/** Validate identity, finiteness, mirror reciprocity, complete seam incidence, and fingerprint integrity. */
export function validateResolvedArenaGeometry(
  candidate: unknown,
): asserts candidate is ResolvedArenaGeometry {
  if (typeof candidate !== 'object' || candidate === null) {
    throw new TypeError('Resolved arena geometry must be an object.');
  }
  const geometry = candidate as ResolvedArenaGeometry;
  if (geometry.units !== 'meters'
    || geometry.identity?.sourceVersion !== ARENA_GEOMETRY_SPEC.version
    || geometry.identity?.primitiveSchemaVersion !== ARENA_PRIMITIVE_SCHEMA_VERSION) {
    throw new TypeError('Resolved arena geometry identity is unsupported.');
  }
  if (!finiteNumbers(geometry)) throw new TypeError('Resolved arena geometry contains a non-finite number or negative zero.');
  if (!Array.isArray(geometry.primitives)
    || !Array.isArray(geometry.surfaces)
    || !Array.isArray(geometry.seams)
    || !Array.isArray(geometry.goals)) {
    throw new TypeError('Resolved arena geometry tables are required.');
  }

  const primitiveMap = new Map<string, ResolvedArenaBoundaryPrimitive>();
  for (const primitive of geometry.primitives) {
    if (primitiveMap.has(primitive.id)) throw new TypeError(`Duplicate arena primitive ID ${primitive.id}.`);
    primitiveMap.set(primitive.id, primitive);
    if (primitive.inwardSurface.positions.length !== primitive.inwardSurface.normals.length
      || primitive.inwardSurface.positions.length !== primitive.inwardSurface.uvs.length
      || primitive.inwardSurface.indices.length === 0
      || primitive.inwardSurface.indices.length % 3 !== 0
      || primitive.inwardSurface.indices.some((index: number) => (
        !Number.isSafeInteger(index) || index < 0 || index >= primitive.inwardSurface.positions.length
      ))) {
      throw new TypeError(`Arena primitive ${primitive.id} has invalid indexed inward geometry.`);
    }
    for (let index = 0; index < primitive.inwardSurface.indices.length; index += 3) {
      const first = primitive.inwardSurface.positions[primitive.inwardSurface.indices[index]!]!;
      const second = primitive.inwardSurface.positions[primitive.inwardSurface.indices[index + 1]!]!;
      const third = primitive.inwardSurface.positions[primitive.inwardSurface.indices[index + 2]!]!;
      const triangleNormal = cross3(subtract3(second, first), subtract3(third, first));
      const declared = primitive.inwardSurface.normals[primitive.inwardSurface.indices[index]!]!;
      if (dot3(triangleNormal, declared) <= 0) {
        throw new TypeError(`Arena primitive ${primitive.id} has reflected inward winding.`);
      }
    }
  }

  const surfaceMap = new Map<string, ResolvedArenaSurface>();
  for (const surface of geometry.surfaces) {
    if (surfaceMap.has(surface.id)) throw new TypeError(`Duplicate resolved arena surface ID ${surface.id}.`);
    surfaceMap.set(surface.id, surface);
    if (surface.primitiveIds.length === 0) throw new TypeError(`Resolved arena surface ${surface.id} is unused.`);
    for (const primitiveId of surface.primitiveIds) {
      if (primitiveMap.get(primitiveId)?.surfaceId !== surface.id) {
        throw new TypeError(`Resolved surface ${surface.id} has invalid primitive ${primitiveId}.`);
      }
    }
  }
  for (const primitive of geometry.primitives) {
    if (!surfaceMap.has(primitive.surfaceId)) throw new TypeError(`Primitive ${primitive.id} references an unknown surface.`);
    if (primitive.mirroredPrimitiveId === null) {
      if (primitive.mirrorAxes.length !== 0) throw new TypeError(`Self-symmetric primitive ${primitive.id} declares mirror axes.`);
      continue;
    }
    const mirror = primitiveMap.get(primitive.mirroredPrimitiveId);
    if (mirror === undefined || mirror.mirroredPrimitiveId !== primitive.id) {
      throw new TypeError(`Primitive ${primitive.id} has a non-reciprocal mirror.`);
    }
    if (primitive.mirrorAxes.join(',') !== mirror.mirrorAxes.join(',')) {
      throw new TypeError(`Primitive ${primitive.id} and its mirror disagree on axes.`);
    }
    if (primitive.collision.shape !== mirror.collision.shape) {
      throw new TypeError(`Primitive ${primitive.id} and its mirror use different collision shapes.`);
    }
    if (primitive.collision.shape === 'convex-hull' && mirror.collision.shape === 'convex-hull') {
      const expected = sortedPointKeys(primitive.collision.vertices.map((point: ArenaVector3Tuple) => (
        transformedPoint(point, primitive.mirrorAxes)
      )));
      if (JSON.stringify(expected) !== JSON.stringify(sortedPointKeys(mirror.collision.vertices))) {
        throw new TypeError(`Primitive ${primitive.id} collision mirror is not exact.`);
      }
    }
    const expectedPositions = sortedPointKeys(primitive.inwardSurface.positions.map((point: ArenaVector3Tuple) => (
      transformedPoint(point, primitive.mirrorAxes)
    )));
    if (JSON.stringify(expectedPositions) !== JSON.stringify(sortedPointKeys(mirror.inwardSurface.positions))) {
      throw new TypeError(`Primitive ${primitive.id} inward-surface mirror is not exact: ${JSON.stringify(expectedPositions)} != ${JSON.stringify(sortedPointKeys(mirror.inwardSurface.positions))}.`);
    }
    const expectedNormals = sortedPointKeys(primitive.inwardSurface.normals.map((normal: ArenaVector3Tuple) => (
      transformedPoint(normal, primitive.mirrorAxes)
    )));
    if (JSON.stringify(expectedNormals) !== JSON.stringify(sortedPointKeys(mirror.inwardSurface.normals))) {
      throw new TypeError(`Primitive ${primitive.id} inward-normal mirror is not exact.`);
    }
  }

  const seamMap = new Map<string, ResolvedArenaSeam>();
  for (const seam of geometry.seams) {
    if (seamMap.has(seam.id)) throw new TypeError(`Duplicate resolved arena seam ID ${seam.id}.`);
    seamMap.set(seam.id, seam);
  }

  const expectedSeamMembership = new Map<string, Set<string>>();
  for (const seam of geometry.seams) {
    const mirror = seamMap.get(seam.mirroredSeamId);
    if (mirror === undefined || mirror.mirroredSeamId !== seam.id) {
      throw new TypeError(`Seam ${seam.id} has a non-reciprocal mirror.`);
    }
    if (seam.mirrorAxes.join(',') !== mirror.mirrorAxes.join(',')) {
      throw new TypeError(`Seam ${seam.id} and its mirror disagree on axes.`);
    }
    if (seam.kind !== mirror.kind || seam.topology !== mirror.topology) {
      throw new TypeError(`Seam ${seam.id} and its mirror disagree on topology.`);
    }
    const mirroredApertureId = seam.apertureId === 'blue-goal'
      ? 'orange-goal'
      : seam.apertureId === 'orange-goal' ? 'blue-goal' : null;
    if (mirror.apertureId !== mirroredApertureId) {
      throw new TypeError(`Seam ${seam.id} and its mirror disagree on aperture identity.`);
    }
    const expectedMirrorEdges = seam.edges.map((edge: ResolvedArenaSeamEdge) => edgeKey([
      transformedPoint(edge.endpoints[0], seam.mirrorAxes),
      transformedPoint(edge.endpoints[1], seam.mirrorAxes),
    ])).sort();
    const actualMirrorEdges = mirror.edges.map((edge: ResolvedArenaSeamEdge) => (
      edgeKey(edge.endpoints)
    )).sort();
    if (JSON.stringify(expectedMirrorEdges) !== JSON.stringify(actualMirrorEdges)) {
      throw new TypeError(`Seam ${seam.id} world-space mirror is not exact.`);
    }
    if (seam.edges.length === 0) throw new TypeError(`Seam ${seam.id} has no world-space edges.`);
    if (seam.topology === 'joined' && (seam.kind === 'goal-aperture' || seam.apertureId !== null)) {
      throw new TypeError(`Joined seam ${seam.id} cannot declare a goal aperture.`);
    }
    if (seam.topology === 'goal-aperture'
      && (seam.kind !== 'goal-aperture' || seam.apertureId === null)) {
      throw new TypeError(`Goal aperture seam ${seam.id} has invalid topology metadata.`);
    }
    for (const edge of seam.edges) {
      if (samePoint(edge.endpoints[0], edge.endpoints[1])) {
        throw new TypeError(`Seam ${seam.id} contains a zero-length edge.`);
      }
      if (edge.primitiveIds.length < 2
        || new Set(edge.primitiveIds).size !== edge.primitiveIds.length) {
        throw new TypeError(`Seam ${seam.id} has incomplete or duplicate primitive incidence.`);
      }
      for (const primitiveId of edge.primitiveIds) {
        const primitive = primitiveMap.get(primitiveId);
        if (primitive === undefined) throw new TypeError(`Seam ${seam.id} references unknown primitive ${primitiveId}.`);
        if (!edge.endpoints.every((endpoint: ArenaVector3Tuple) => surfaceContainsPoint(primitive.inwardSurface, endpoint))) {
          throw new TypeError(`Seam ${seam.id} endpoints do not lie on primitive ${primitiveId}.`);
        }
        const memberships = expectedSeamMembership.get(primitiveId) ?? new Set<string>();
        memberships.add(seam.id);
        expectedSeamMembership.set(primitiveId, memberships);
      }
    }
  }

  const topologyPoints: ArenaVector3Tuple[] = [];
  const addTopologyPoint = (point: ArenaVector3Tuple): void => {
    if (!topologyPoints.some((candidatePoint) => samePoint(candidatePoint, point))) {
      topologyPoints.push(point);
    }
  };
  const boundaryEdgesByPrimitive = new Map<string, ArenaEdgeEndpoints[]>();
  for (const primitive of geometry.primitives) {
    const boundaryEdges = surfaceBoundaryEdges(primitive);
    boundaryEdgesByPrimitive.set(primitive.id, boundaryEdges);
    for (const endpoints of boundaryEdges) endpoints.forEach(addTopologyPoint);
  }
  for (const seam of geometry.seams) {
    for (const edge of seam.edges) edge.endpoints.forEach(addTopologyPoint);
  }

  const boundaryIncidence = new Map<string, {
    endpoints: ArenaEdgeEndpoints;
    primitiveIds: Set<string>;
  }>();
  for (const primitive of geometry.primitives) {
    for (const endpoints of boundaryEdgesByPrimitive.get(primitive.id)!) {
      const atomicEdges = splitEdgeAtPoints(endpoints, topologyPoints);
      if (atomicEdges.length === 0) {
        throw new TypeError(`Arena primitive ${primitive.id} has an unsplittable boundary edge.`);
      }
      for (const atomicEdge of atomicEdges) {
        const key = edgeKey(atomicEdge);
        const incidence = boundaryIncidence.get(key) ?? {
          endpoints: atomicEdge,
          primitiveIds: new Set<string>(),
        };
        if (incidence.primitiveIds.has(primitive.id)) {
          throw new TypeError(`Arena primitive ${primitive.id} repeats boundary segment ${key}.`);
        }
        incidence.primitiveIds.add(primitive.id);
        boundaryIncidence.set(key, incidence);
      }
    }
  }

  const declaredIncidence = new Map<string, string>();
  for (const seam of geometry.seams) {
    for (const edge of seam.edges) {
      const declaredPrimitiveIds = [...edge.primitiveIds].sort();
      const atomicEdges = splitEdgeAtPoints(edge.endpoints, topologyPoints);
      if (atomicEdges.length === 0) throw new TypeError(`Seam ${seam.id} has an unsplittable edge.`);
      for (const atomicEdge of atomicEdges) {
        const key = edgeKey(atomicEdge);
        const incidence = boundaryIncidence.get(key);
        if (incidence === undefined) {
          throw new TypeError(`Seam ${seam.id} edge ${key} is not a primitive boundary segment.`);
        }
        const previousSeamId = declaredIncidence.get(key);
        if (previousSeamId !== undefined) {
          throw new TypeError(`Boundary segment ${key} is declared by both ${previousSeamId} and ${seam.id}.`);
        }
        const actualPrimitiveIds = [...incidence.primitiveIds].sort();
        if (JSON.stringify(actualPrimitiveIds) !== JSON.stringify(declaredPrimitiveIds)) {
          throw new TypeError(
            `Seam ${seam.id} incidence for ${key} is ${JSON.stringify(declaredPrimitiveIds)};`
            + ` expected ${JSON.stringify(actualPrimitiveIds)}.`,
          );
        }
        declaredIncidence.set(key, seam.id);
      }
    }
  }
  for (const [key, incidence] of boundaryIncidence) {
    if (incidence.primitiveIds.size !== 2) {
      throw new TypeError(
        `Arena boundary segment ${key} has ${incidence.primitiveIds.size} primitive incidences; expected 2.`,
      );
    }
    if (!declaredIncidence.has(key)) {
      throw new TypeError(`Arena boundary segment ${key} has no declared seam.`);
    }
  }
  for (const primitive of geometry.primitives) {
    const declared = primitive.inwardSurface.seamIds;
    const expected = [...(expectedSeamMembership.get(primitive.id) ?? [])].sort();
    if (new Set(declared).size !== declared.length
      || JSON.stringify([...declared].sort()) !== JSON.stringify(expected)) {
      throw new TypeError(`Primitive ${primitive.id} has incomplete reciprocal seam membership.`);
    }
  }

  const apertureSeams = geometry.seams.filter(({ topology }) => topology === 'goal-aperture');
  const apertureIds = apertureSeams.map(({ apertureId }) => apertureId).sort();
  const apertureSeamIds = apertureSeams.map(({ id }) => id).sort();
  if (apertureSeams.length !== 2
    || JSON.stringify(apertureIds) !== JSON.stringify(['blue-goal', 'orange-goal'])
    || geometry.topology?.closedCollisionVolume !== true
    || JSON.stringify([...geometry.topology.unmatchedApertureIds].sort()) !== JSON.stringify(apertureIds)
    || JSON.stringify([...geometry.topology.unmatchedSeamIds].sort()) !== JSON.stringify(apertureSeamIds)) {
    throw new TypeError('Only the two declared goal apertures may be unmatched topology groups.');
  }
  const expectedFingerprint = computeArenaGeometryFingerprint(geometry);
  if (geometry.identity.fingerprint !== expectedFingerprint) {
    throw new TypeError('Resolved arena geometry fingerprint does not match its canonical descriptors.');
  }
}

function buildProfiles(spec: ArenaGeometrySpec): ResolvedArenaGeometry['profiles'] {
  const floorWallSamples: ResolvedFloorWallProfileSample[] = [];
  const wallCeilingSamples: ResolvedWallCeilingProfileSample[] = [];
  for (let index = 0; index <= ARENA_TRANSITION_SEGMENT_COUNT; index += 1) {
    const theta = index * Math.PI / 16;
    floorWallSamples.push({
      index,
      theta: canonicalNumber(theta),
      outward: canonicalNumber(ARENA_FLOOR_WALL_RAMP_RUN_METERS * Math.sin(theta)),
      up: canonicalNumber(spec.floorWallRamp.height * (1 - Math.cos(theta))),
    });
    wallCeilingSamples.push({
      index,
      theta: canonicalNumber(theta),
      inward: canonicalNumber(ARENA_WALL_CEILING_TRANSITION_RUN_METERS * (1 - Math.cos(theta))),
      up: canonicalNumber(ARENA_WALL_CEILING_TRANSITION_RISE_METERS * Math.sin(theta)),
    });
  }
  return {
    floorWall: {
      kind: 'equal-angle-quarter-ellipse',
      run: ARENA_FLOOR_WALL_RAMP_RUN_METERS,
      rise: spec.floorWallRamp.height,
      segmentCount: ARENA_TRANSITION_SEGMENT_COUNT,
      samples: floorWallSamples,
    },
    wallCeiling: {
      kind: 'equal-angle-quarter-ellipse',
      run: ARENA_WALL_CEILING_TRANSITION_RUN_METERS,
      rise: ARENA_WALL_CEILING_TRANSITION_RISE_METERS,
      segmentCount: ARENA_TRANSITION_SEGMENT_COUNT,
      samples: wallCeilingSamples,
    },
  };
}

function resolvedCornerCuts(spec: ArenaGeometrySpec): ResolvedCornerCut[] {
  return spec.cornerCuts.map((corner) => {
    const first = vector2(
      corner.xSign * (spec.halfWidth - corner.horizontalLength),
      corner.zSign * spec.halfLength,
    );
    const second = vector2(
      corner.xSign * spec.halfWidth,
      corner.zSign * (spec.halfLength - corner.horizontalLength),
    );
    return {
      id: corner.id,
      surfaceId: corner.surfaceId,
      xSign: corner.xSign,
      zSign: corner.zSign,
      axisRetreat: corner.horizontalLength,
      angleDegrees: corner.angleDegrees,
      endpoints: [first, second] as const,
      segmentLength: canonicalNumber(Math.hypot(second[0] - first[0], second[1] - first[1])),
    };
  }).sort((left, right) => left.id.localeCompare(right.id));
}

function surfaceMaterialRoles(
  descriptor: ArenaSurfaceDescriptor,
  primitives: readonly ResolvedArenaBoundaryPrimitive[],
): ArenaBoundaryMaterialRole[] {
  return [...new Set(
    primitives.filter(({ surfaceId }) => surfaceId === descriptor.id).map(({ materialRole }) => materialRole),
  )].sort();
}

/** Resolve the exact semantic spec into the sole operational arena primitive contract. */
export function resolveArenaGeometry(candidate: unknown): ResolvedArenaGeometry {
  validateArenaGeometrySpec(candidate);
  const spec: ArenaGeometrySpec = candidate;
  const profiles = buildProfiles(spec);
  const openingHalfWidth = spec.goal.openingWidth / 2;
  const wallBottomY = profiles.floorWall.rise;
  const wallTopY = spec.ceilingHeight - profiles.wallCeiling.rise;

  const footprint: readonly ArenaVector2Tuple[] = [
    vector2(spec.halfWidth, -spec.halfLength + spec.cornerCuts[0]!.horizontalLength),
    vector2(spec.halfWidth, spec.halfLength - spec.cornerCuts[0]!.horizontalLength),
    vector2(spec.halfWidth - spec.cornerCuts[0]!.horizontalLength, spec.halfLength),
    vector2(-spec.halfWidth + spec.cornerCuts[0]!.horizontalLength, spec.halfLength),
    vector2(-spec.halfWidth, spec.halfLength - spec.cornerCuts[0]!.horizontalLength),
    vector2(-spec.halfWidth, -spec.halfLength + spec.cornerCuts[0]!.horizontalLength),
    vector2(-spec.halfWidth + spec.cornerCuts[0]!.horizontalLength, -spec.halfLength),
    vector2(spec.halfWidth - spec.cornerCuts[0]!.horizontalLength, -spec.halfLength),
  ];
  const edgeDefinitions = [
    ['east', 'side', 'field.ramp.east', 'field.wall.east', 'field.transition.east-ceiling'],
    ['orange-east', 'corner', 'field.corner.orange-east', 'field.corner.orange-east', 'field.corner.orange-east'],
    ['orange-end', 'end', 'field.ramp.orange-end', 'field.wall.orange-end', 'field.transition.orange-ceiling'],
    ['orange-west', 'corner', 'field.corner.orange-west', 'field.corner.orange-west', 'field.corner.orange-west'],
    ['west', 'side', 'field.ramp.west', 'field.wall.west', 'field.transition.west-ceiling'],
    ['blue-west', 'corner', 'field.corner.blue-west', 'field.corner.blue-west', 'field.corner.blue-west'],
    ['blue-end', 'end', 'field.ramp.blue-end', 'field.wall.blue-end', 'field.transition.blue-ceiling'],
    ['blue-east', 'corner', 'field.corner.blue-east', 'field.corner.blue-east', 'field.corner.blue-east'],
  ] as const;
  const footprintEdges: FootprintEdge[] = edgeDefinitions.map((definition, index) => {
    const start = footprint[index]!;
    const end = footprint[(index + 1) % footprint.length]!;
    const dx = end[0] - start[0];
    const dz = end[1] - start[1];
    const length = Math.hypot(dx, dz);
    return {
      index,
      id: definition[0],
      category: definition[1],
      surfaceIds: { lower: definition[2], wall: definition[3], upper: definition[4] },
      inward: vector2(-dz / length, dx / length),
    };
  });

  const offsetRing = (distance: number): readonly ArenaVector2Tuple[] => footprint.map((_, index) => {
    const previousIndex = (index + footprint.length - 1) % footprint.length;
    const previousEdge = footprintEdges[previousIndex]!;
    const currentEdge = footprintEdges[index]!;
    return offsetLineIntersection(
      footprint[previousIndex]!,
      footprint[index]!,
      previousEdge.inward,
      footprint[index]!,
      footprint[(index + 1) % footprint.length]!,
      currentEdge.inward,
      canonicalNumber(distance),
    );
  });

  const lowerRings = profiles.floorWall.samples.map((sample) => (
    offsetRing(profiles.floorWall.run - sample.outward)
  ));
  const upperRings = profiles.wallCeiling.samples.map((sample) => offsetRing(sample.inward));
  const primitives: MutablePrimitive[] = [];
  const primitiveMap = new Map<string, MutablePrimitive>();
  const addPrimitive = (primitive: MutablePrimitive): void => {
    if (primitiveMap.has(primitive.id)) throw new TypeError(`Duplicate arena primitive ID ${primitive.id}.`);
    primitives.push(primitive);
    primitiveMap.set(primitive.id, primitive);
  };

  const floorBoundary = lowerRings[0]!.map((point) => vector3(point[0], spec.floorY, point[1]));
  addPrimitive(prismPrimitive(
    'field.floor.center',
    'field.floor',
    'field',
    'floor',
    'field-floor',
    floorBoundary,
    vector3(0, 1, 0),
  ));

  const floorApproachIds = new Map<'blue' | 'orange', string>();
  for (const end of spec.goal.ends) {
    const goal = end.zDirection < 0 ? 'blue' : 'orange';
    const innerZ = end.zDirection * (spec.halfLength - profiles.floorWall.run);
    const id = `field.floor.${goal}-mouth-approach`;
    floorApproachIds.set(goal, id);
    addPrimitive(prismPrimitive(
      id,
      'field.floor',
      'field',
      'floor',
      'field-floor',
      [
        vector3(-openingHalfWidth, spec.floorY, innerZ),
        vector3(openingHalfWidth, spec.floorY, innerZ),
        vector3(openingHalfWidth, spec.floorY, end.goalLineZ),
        vector3(-openingHalfWidth, spec.floorY, end.goalLineZ),
      ],
      vector3(0, 1, 0),
    ));
  }

  const pointFor = (
    ring: readonly ArenaVector2Tuple[],
    edge: FootprintEdge,
    endpoint: 0 | 1,
    y: number,
  ): ArenaVector3Tuple => {
    const point = ring[(edge.index + endpoint) % ring.length]!;
    return vector3(point[0], y, point[1]);
  };

  const splitEndEdge = (
    edge: FootprintEdge,
    ring: readonly ArenaVector2Tuple[],
    y: number,
  ): Readonly<Record<'east' | 'west', readonly [ArenaVector3Tuple, ArenaVector3Tuple]>> => {
    const start = pointFor(ring, edge, 0, y);
    const end = pointFor(ring, edge, 1, y);
    const z = start[2];
    if (start[0] > end[0]) {
      return {
        east: [start, vector3(openingHalfWidth, y, z)],
        west: [vector3(-openingHalfWidth, y, z), end],
      };
    }
    return {
      west: [start, vector3(-openingHalfWidth, y, z)],
      east: [vector3(openingHalfWidth, y, z), end],
    };
  };

  const lowerStrips: LowerStripRecord[] = [];
  for (const edge of footprintEdges) {
    const parts: readonly ('east' | 'west' | null)[] = edge.category === 'end'
      ? ['east', 'west']
      : [null];
    for (const side of parts) {
      const sampleEdges = profiles.floorWall.samples.map((sample, sampleIndex) => {
        const y = spec.floorY + sample.up;
        if (side === null) {
          return [
            pointFor(lowerRings[sampleIndex]!, edge, 0, y),
            pointFor(lowerRings[sampleIndex]!, edge, 1, y),
          ] as const;
        }
        return splitEndEdge(edge, lowerRings[sampleIndex]!, y)[side];
      });
      const key = edge.category === 'corner'
        ? `corner.${edge.id}`
        : edge.category === 'end' ? `${edge.id}.${side}` : edge.id;
      const wallId = edge.category === 'corner'
        ? `field.wall.corner.${edge.id}`
        : edge.category === 'end' ? `field.wall.${edge.id}.${side}` : `field.wall.${edge.id}`;
      const primitiveIds: string[] = [];
      for (let segment = 0; segment < ARENA_TRANSITION_SEGMENT_COUNT; segment += 1) {
        const current = profiles.floorWall.samples[segment]!;
        const next = profiles.floorWall.samples[segment + 1]!;
        const horizontal = next.outward - current.outward;
        const vertical = next.up - current.up;
        const desiredNormal = normalize3(vector3(
          edge.inward[0] * vertical,
          horizontal,
          edge.inward[1] * vertical,
        ));
        const id = `field.lower.${key}.segment-${segment.toString().padStart(2, '0')}`;
        primitiveIds.push(id);
        addPrimitive(prismPrimitive(
          id,
          edge.surfaceIds.lower,
          'field',
          'lower-transition',
          'field-lower-transition',
          [
            sampleEdges[segment]![0],
            sampleEdges[segment]![1],
            sampleEdges[segment + 1]![1],
            sampleEdges[segment + 1]![0],
          ],
          desiredNormal,
        ));
      }
      lowerStrips.push({
        key,
        edgeId: edge.id,
        side,
        sampleEdges,
        primitiveIds,
        surfaceId: edge.surfaceIds.lower,
        wallId,
      });
    }
  }

  const wallIdsByEdge = new Map<string, readonly string[]>();
  for (const edge of footprintEdges) {
    if (edge.category === 'end') {
      const split = splitEndEdge(edge, footprint, wallBottomY);
      const ids: string[] = [];
      for (const side of ['east', 'west'] as const) {
        const lower = split[side];
        const id = `field.wall.${edge.id}.${side}`;
        ids.push(id);
        addPrimitive(prismPrimitive(
          id,
          edge.surfaceIds.wall,
          'field',
          'wall',
          'field-containment',
          [
            lower[0],
            lower[1],
            vector3(lower[1][0], wallTopY, lower[1][2]),
            vector3(lower[0][0], wallTopY, lower[0][2]),
          ],
          vector3(edge.inward[0], 0, edge.inward[1]),
        ));
      }
      const end = spec.goal.ends.find(({ zDirection }) => (
        (edge.id.startsWith('blue') ? -1 : 1) === zDirection
      ))!;
      const topId = `field.wall.${edge.id}.opening-top`;
      ids.push(topId);
      addPrimitive(prismPrimitive(
        topId,
        edge.surfaceIds.wall,
        'field',
        'wall',
        'field-containment',
        [
          vector3(-openingHalfWidth, end.opening.height, end.goalLineZ),
          vector3(openingHalfWidth, end.opening.height, end.goalLineZ),
          vector3(openingHalfWidth, wallTopY, end.goalLineZ),
          vector3(-openingHalfWidth, wallTopY, end.goalLineZ),
        ],
        vector3(edge.inward[0], 0, edge.inward[1]),
      ));
      wallIdsByEdge.set(edge.id, ids);
      continue;
    }
    const start = pointFor(footprint, edge, 0, wallBottomY);
    const end = pointFor(footprint, edge, 1, wallBottomY);
    const id = edge.category === 'corner'
      ? `field.wall.corner.${edge.id}`
      : `field.wall.${edge.id}`;
    addPrimitive(prismPrimitive(
      id,
      edge.surfaceIds.wall,
      'field',
      edge.category === 'corner' ? 'corner-cut' : 'wall',
      'field-containment',
      [
        start,
        end,
        vector3(end[0], wallTopY, end[2]),
        vector3(start[0], wallTopY, start[2]),
      ],
      vector3(edge.inward[0], 0, edge.inward[1]),
    ));
    wallIdsByEdge.set(edge.id, [id]);
  }

  const upperStrips: UpperStripRecord[] = [];
  for (const edge of footprintEdges) {
    const sampleEdges = profiles.wallCeiling.samples.map((sample, sampleIndex) => {
      const y = wallTopY + sample.up;
      return [
        pointFor(upperRings[sampleIndex]!, edge, 0, y),
        pointFor(upperRings[sampleIndex]!, edge, 1, y),
      ] as const;
    });
    const key = edge.category === 'corner' ? `corner.${edge.id}` : edge.id;
    const primitiveIds: string[] = [];
    for (let segment = 0; segment < ARENA_TRANSITION_SEGMENT_COUNT; segment += 1) {
      const current = profiles.wallCeiling.samples[segment]!;
      const next = profiles.wallCeiling.samples[segment + 1]!;
      const horizontal = next.inward - current.inward;
      const vertical = next.up - current.up;
      const desiredNormal = normalize3(vector3(
        edge.inward[0] * vertical,
        -horizontal,
        edge.inward[1] * vertical,
      ));
      const id = `field.upper.${key}.segment-${segment.toString().padStart(2, '0')}`;
      primitiveIds.push(id);
      addPrimitive(prismPrimitive(
        id,
        edge.surfaceIds.upper,
        'field',
        'upper-transition',
        'field-containment',
        [
          sampleEdges[segment]![0],
          sampleEdges[segment]![1],
          sampleEdges[segment + 1]![1],
          sampleEdges[segment + 1]![0],
        ],
        desiredNormal,
      ));
    }
    upperStrips.push({
      key,
      edgeId: edge.id,
      sampleEdges,
      primitiveIds,
      surfaceId: edge.surfaceIds.upper,
    });
  }

  const ceilingBoundary = upperRings[ARENA_TRANSITION_SEGMENT_COUNT]!
    .map((point) => vector3(point[0], spec.ceilingHeight, point[1]));
  addPrimitive(prismPrimitive(
    'field.ceiling.center',
    'field.ceiling',
    'field',
    'ceiling',
    'field-ceiling',
    ceilingBoundary,
    vector3(0, -1, 0),
  ));

  const goalSurfacePrimitiveIds = new Map<'blue' | 'orange', string[]>();
  for (const end of spec.goal.ends) {
    const goal = end.zDirection < 0 ? 'blue' : 'orange';
    const region: ArenaRegion = `${goal}-goal`;
    const materialRole: ArenaBoundaryMaterialRole = `${goal}-goal`;
    const ids: string[] = [];
    const definitions: readonly [string, string, readonly ArenaVector3Tuple[], ArenaVector3Tuple][] = [
      [
        `goal.${goal}.floor`,
        `goal.${goal}.floor`,
        [
          vector3(-openingHalfWidth, spec.floorY, end.goalLineZ),
          vector3(openingHalfWidth, spec.floorY, end.goalLineZ),
          vector3(openingHalfWidth, spec.floorY, end.backWallZ),
          vector3(-openingHalfWidth, spec.floorY, end.backWallZ),
        ],
        vector3(0, 1, 0),
      ],
      [
        `goal.${goal}.side-east`,
        `goal.${goal}.side-east`,
        [
          vector3(openingHalfWidth, spec.floorY, end.goalLineZ),
          vector3(openingHalfWidth, spec.floorY, end.backWallZ),
          vector3(openingHalfWidth, end.opening.height, end.backWallZ),
          vector3(openingHalfWidth, end.opening.height, end.goalLineZ),
        ],
        vector3(-1, 0, 0),
      ],
      [
        `goal.${goal}.side-west`,
        `goal.${goal}.side-west`,
        [
          vector3(-openingHalfWidth, spec.floorY, end.backWallZ),
          vector3(-openingHalfWidth, spec.floorY, end.goalLineZ),
          vector3(-openingHalfWidth, end.opening.height, end.goalLineZ),
          vector3(-openingHalfWidth, end.opening.height, end.backWallZ),
        ],
        vector3(1, 0, 0),
      ],
      [
        `goal.${goal}.roof`,
        `goal.${goal}.roof`,
        [
          vector3(-openingHalfWidth, end.opening.height, end.goalLineZ),
          vector3(-openingHalfWidth, end.opening.height, end.backWallZ),
          vector3(openingHalfWidth, end.opening.height, end.backWallZ),
          vector3(openingHalfWidth, end.opening.height, end.goalLineZ),
        ],
        vector3(0, -1, 0),
      ],
      [
        `goal.${goal}.back`,
        `goal.${goal}.back`,
        [
          vector3(-openingHalfWidth, spec.floorY, end.backWallZ),
          vector3(openingHalfWidth, spec.floorY, end.backWallZ),
          vector3(openingHalfWidth, end.opening.height, end.backWallZ),
          vector3(-openingHalfWidth, end.opening.height, end.backWallZ),
        ],
        vector3(0, 0, -end.zDirection),
      ],
    ];
    for (const [id, surfaceId, boundary, normal] of definitions) {
      ids.push(id);
      addPrimitive(prismPrimitive(
        id,
        surfaceId,
        region,
        'goal-interior',
        materialRole,
        boundary,
        normal,
      ));
    }
    goalSurfacePrimitiveIds.set(goal, ids);
  }

  const jambRecords: JambRecord[] = [];
  for (const lowerStrip of lowerStrips.filter(({ edgeId }) => edgeId.endsWith('-end'))) {
    const goal = lowerStrip.edgeId.startsWith('blue') ? 'blue' : 'orange';
    const side = lowerStrip.side!;
    const sideX = side === 'east' ? openingHalfWidth : -openingHalfWidth;
    const curvePoints = lowerStrip.sampleEdges.map((edge) => (
      Math.abs(edge[0][0] - sideX) <= EPSILON ? edge[0] : edge[1]
    ));
    const floorPoints = curvePoints.map((point) => vector3(point[0], spec.floorY, point[2]));
    const primitiveIds: string[] = [];
    for (let segment = 0; segment < ARENA_TRANSITION_SEGMENT_COUNT; segment += 1) {
      const id = `field.goal-jamb.${goal}.${side}.segment-${segment.toString().padStart(2, '0')}`;
      primitiveIds.push(id);
      addPrimitive(prismPrimitive(
        id,
        lowerStrip.surfaceId,
        'field',
        'lower-transition',
        'field-lower-transition',
        [curvePoints[segment]!, curvePoints[segment + 1]!, floorPoints[segment + 1]!, floorPoints[segment]!],
        vector3(side === 'east' ? -1 : 1, 0, 0),
      ));
    }
    jambRecords.push({
      goal,
      side,
      lowerStrip,
      curvePoints,
      floorPoints,
      primitiveIds,
      goalSidePrimitiveId: `goal.${goal}.side-${side}`,
      floorPrimitiveId: floorApproachIds.get(goal)!,
    });
  }

  const pairPrimitive = (
    firstId: string,
    secondId: string,
    axes: readonly ArenaMirrorAxis[],
  ): void => {
    const first = primitiveMap.get(firstId);
    const second = primitiveMap.get(secondId);
    if (first === undefined || second === undefined) {
      throw new TypeError(`Missing primitive mirror pair ${firstId} <-> ${secondId}.`);
    }
    first.mirroredPrimitiveId = secondId;
    second.mirroredPrimitiveId = firstId;
    first.mirrorAxes = [...axes];
    second.mirrorAxes = [...axes];

    // Counterparts are not independently sampled: derive the second primitive
    // from the first and reverse each reflected triangle exactly once per axis.
    if (first.collision.shape !== 'convex-hull') {
      throw new TypeError(`Canonical primitive ${first.id} must use a mirrorable convex hull.`);
    }
    second.collision = {
      shape: 'convex-hull',
      vertices: first.collision.vertices.map((point) => transformedPoint(point, axes)),
    };
    const reflectedIndices = [...first.inwardSurface.indices];
    if (axes.length % 2 === 1) {
      for (let index = 0; index < reflectedIndices.length; index += 3) {
        const secondIndex = reflectedIndices[index + 1]!;
        reflectedIndices[index + 1] = reflectedIndices[index + 2]!;
        reflectedIndices[index + 2] = secondIndex;
      }
    }
    second.inwardSurface = {
      positions: first.inwardSurface.positions.map((point) => transformedPoint(point, axes)),
      indices: reflectedIndices,
      normals: first.inwardSurface.normals.map((normal) => transformedPoint(normal, axes)),
      uvs: first.inwardSurface.uvs.map((uv) => vector2(uv[0], uv[1])),
      seamIds: [],
    };
  };

  pairPrimitive('field.floor.blue-mouth-approach', 'field.floor.orange-mouth-approach', ['z']);
  pairPrimitive('field.wall.east', 'field.wall.west', ['x']);
  for (let segment = 0; segment < ARENA_TRANSITION_SEGMENT_COUNT; segment += 1) {
    const suffix = `segment-${segment.toString().padStart(2, '0')}`;
    pairPrimitive(`field.lower.east.${suffix}`, `field.lower.west.${suffix}`, ['x']);
    pairPrimitive(`field.upper.east.${suffix}`, `field.upper.west.${suffix}`, ['x']);
    for (const [first, second] of [
      ['blue-east', 'orange-west'],
      ['blue-west', 'orange-east'],
    ] as const) {
      pairPrimitive(`field.lower.corner.${first}.${suffix}`, `field.lower.corner.${second}.${suffix}`, ['x', 'z']);
      pairPrimitive(`field.upper.corner.${first}.${suffix}`, `field.upper.corner.${second}.${suffix}`, ['x', 'z']);
      pairPrimitive(`field.lower.${first.split('-')[0]}-end.${first.split('-')[1]}.${suffix}`, `field.lower.${second.split('-')[0]}-end.${second.split('-')[1]}.${suffix}`, ['x', 'z']);
      pairPrimitive(`field.goal-jamb.${first.split('-')[0]}.${first.split('-')[1]}.${suffix}`, `field.goal-jamb.${second.split('-')[0]}.${second.split('-')[1]}.${suffix}`, ['x', 'z']);
    }
    pairPrimitive(`field.upper.blue-end.${suffix}`, `field.upper.orange-end.${suffix}`, ['z']);
  }
  for (const [first, second] of [
    ['blue-east', 'orange-west'],
    ['blue-west', 'orange-east'],
  ] as const) {
    pairPrimitive(`field.wall.corner.${first}`, `field.wall.corner.${second}`, ['x', 'z']);
    pairPrimitive(`field.wall.${first.split('-')[0]}-end.${first.split('-')[1]}`, `field.wall.${second.split('-')[0]}-end.${second.split('-')[1]}`, ['x', 'z']);
  }
  pairPrimitive('field.wall.blue-end.opening-top', 'field.wall.orange-end.opening-top', ['z']);
  pairPrimitive('goal.blue.floor', 'goal.orange.floor', ['z']);
  pairPrimitive('goal.blue.roof', 'goal.orange.roof', ['z']);
  pairPrimitive('goal.blue.back', 'goal.orange.back', ['z']);
  pairPrimitive('goal.blue.side-east', 'goal.orange.side-west', ['x', 'z']);
  pairPrimitive('goal.blue.side-west', 'goal.orange.side-east', ['x', 'z']);

  const unpaired = primitives.filter(({ mirroredPrimitiveId, id }) => (
    mirroredPrimitiveId === null && id !== 'field.floor.center' && id !== 'field.ceiling.center'
  ));
  if (unpaired.length > 0) throw new TypeError(`Unpaired arena primitives: ${unpaired.map(({ id }) => id).join(', ')}`);

  const seamMembership = new Map<string, Set<string>>();
  const seams: MutableSeam[] = [];
  const seamMap = new Map<string, MutableSeam>();
  const addSeam = (
    id: string,
    kind: ArenaSeamKind,
    topology: 'joined' | 'goal-aperture',
    apertureId: 'blue-goal' | 'orange-goal' | null,
    edges: readonly ResolvedArenaSeamEdge[],
  ): void => {
    if (seamMap.has(id)) throw new TypeError(`Duplicate arena seam ID ${id}.`);
    const normalizedEdges = edges.map((edge) => ({
      endpoints: edge.endpoints,
      primitiveIds: [...new Set(edge.primitiveIds)].sort(),
    }));
    const seam: MutableSeam = {
      id,
      kind,
      mirroredSeamId: '',
      mirrorAxes: [],
      topology,
      apertureId,
      edges: normalizedEdges,
    };
    seams.push(seam);
    seamMap.set(id, seam);
    for (const edge of normalizedEdges) {
      for (const primitiveId of edge.primitiveIds) {
        const memberships = seamMembership.get(primitiveId) ?? new Set<string>();
        memberships.add(id);
        seamMembership.set(primitiveId, memberships);
      }
    }
  };
  const seamEdge = (
    first: ArenaVector3Tuple,
    second: ArenaVector3Tuple,
    primitiveIds: readonly string[],
  ): ResolvedArenaSeamEdge => ({ endpoints: [first, second], primitiveIds });

  for (const strip of lowerStrips) {
    addSeam(
      `seam.floor-lower.${strip.key}`,
      'floor-lower',
      'joined',
      null,
      [seamEdge(strip.sampleEdges[0]![0], strip.sampleEdges[0]![1], ['field.floor.center', strip.primitiveIds[0]!])],
    );
    addSeam(
      `seam.lower-profile.${strip.key}`,
      'lower-profile',
      'joined',
      null,
      Array.from({ length: ARENA_TRANSITION_SEGMENT_COUNT - 1 }, (_, index) => {
        const sampleIndex = index + 1;
        return seamEdge(
          strip.sampleEdges[sampleIndex]![0],
          strip.sampleEdges[sampleIndex]![1],
          [strip.primitiveIds[index]!, strip.primitiveIds[sampleIndex]!],
        );
      }),
    );
    addSeam(
      `seam.lower-wall.${strip.key}`,
      'lower-wall',
      'joined',
      null,
      [seamEdge(
        strip.sampleEdges[ARENA_TRANSITION_SEGMENT_COUNT]![0],
        strip.sampleEdges[ARENA_TRANSITION_SEGMENT_COUNT]![1],
        [strip.primitiveIds[ARENA_TRANSITION_SEGMENT_COUNT - 1]!, strip.wallId],
      )],
    );
  }

  for (const upper of upperStrips) {
    const wallIds = wallIdsByEdge.get(upper.edgeId)!;
    const start = upper.sampleEdges[0]![0];
    const end = upper.sampleEdges[0]![1];
    const wallUpperEdges: ResolvedArenaSeamEdge[] = [];
    if (upper.edgeId.endsWith('-end')) {
      const z = start[2];
      const ordered = start[0] < end[0]
        ? [start, vector3(-openingHalfWidth, wallTopY, z), vector3(openingHalfWidth, wallTopY, z), end]
        : [start, vector3(openingHalfWidth, wallTopY, z), vector3(-openingHalfWidth, wallTopY, z), end];
      const sideAtStart = start[0] < end[0] ? 'west' : 'east';
      const sideAtEnd = sideAtStart === 'west' ? 'east' : 'west';
      wallUpperEdges.push(
        seamEdge(ordered[0]!, ordered[1]!, [`field.wall.${upper.edgeId}.${sideAtStart}`, upper.primitiveIds[0]!]),
        seamEdge(ordered[1]!, ordered[2]!, [`field.wall.${upper.edgeId}.opening-top`, upper.primitiveIds[0]!]),
        seamEdge(ordered[2]!, ordered[3]!, [`field.wall.${upper.edgeId}.${sideAtEnd}`, upper.primitiveIds[0]!]),
      );
    } else {
      wallUpperEdges.push(seamEdge(start, end, [wallIds[0]!, upper.primitiveIds[0]!]));
    }
    addSeam(`seam.wall-upper.${upper.key}`, 'wall-upper', 'joined', null, wallUpperEdges);
    addSeam(
      `seam.upper-profile.${upper.key}`,
      'upper-profile',
      'joined',
      null,
      Array.from({ length: ARENA_TRANSITION_SEGMENT_COUNT - 1 }, (_, index) => {
        const sampleIndex = index + 1;
        return seamEdge(
          upper.sampleEdges[sampleIndex]![0],
          upper.sampleEdges[sampleIndex]![1],
          [upper.primitiveIds[index]!, upper.primitiveIds[sampleIndex]!],
        );
      }),
    );
    addSeam(
      `seam.upper-ceiling.${upper.key}`,
      'upper-ceiling',
      'joined',
      null,
      [seamEdge(
        upper.sampleEdges[ARENA_TRANSITION_SEGMENT_COUNT]![0],
        upper.sampleEdges[ARENA_TRANSITION_SEGMENT_COUNT]![1],
        [upper.primitiveIds[ARENA_TRANSITION_SEGMENT_COUNT - 1]!, 'field.ceiling.center'],
      )],
    );
  }

  const lowerAtVertex = (
    edgeIndex: number,
    endpoint: 0 | 1,
  ): LowerStripRecord => {
    const edge = footprintEdges[edgeIndex]!;
    const target = pointFor(lowerRings[0]!, edge, endpoint, spec.floorY);
    const candidates = lowerStrips.filter(({ edgeId }) => edgeId === edge.id);
    const match = candidates.find(({ sampleEdges }) => samePoint(sampleEdges[0]![endpoint], target));
    if (match === undefined) throw new TypeError(`Missing lower strip at ${edge.id}:${endpoint}.`);
    return match;
  };
  const junctionLabels = [
    'orange-east',
    'orange-east',
    'orange-west',
    'orange-west',
    'blue-west',
    'blue-west',
    'blue-east',
    'blue-east',
  ] as const;
  for (let edgeIndex = 0; edgeIndex < footprintEdges.length; edgeIndex += 1) {
    const nextIndex = (edgeIndex + 1) % footprintEdges.length;
    const firstEdge = footprintEdges[edgeIndex]!;
    const nextEdge = footprintEdges[nextIndex]!;
    const firstLower = lowerAtVertex(edgeIndex, 1);
    const nextLower = lowerAtVertex(nextIndex, 0);
    const firstUpper = upperStrips.find(({ edgeId }) => edgeId === firstEdge.id)!;
    const nextUpper = upperStrips.find(({ edgeId }) => edgeId === nextEdge.id)!;
    const kind: ArenaSeamKind = firstEdge.category === 'corner' || nextEdge.category === 'corner'
      ? (firstEdge.category === 'side' || nextEdge.category === 'side' ? 'side-corner' : 'corner-end')
      : 'side-corner';
    const id = `seam.${kind}.${junctionLabels[edgeIndex]}`;
    const edges: ResolvedArenaSeamEdge[] = [];
    for (let segment = 0; segment < ARENA_TRANSITION_SEGMENT_COUNT; segment += 1) {
      edges.push(seamEdge(
        firstLower.sampleEdges[segment]![1],
        firstLower.sampleEdges[segment + 1]![1],
        [firstLower.primitiveIds[segment]!, nextLower.primitiveIds[segment]!],
      ));
    }
    edges.push(seamEdge(
      pointFor(footprint, firstEdge, 1, wallBottomY),
      pointFor(footprint, firstEdge, 1, wallTopY),
      [wallIdsByEdge.get(firstEdge.id)!.find((primitiveId) => {
        const primitive = primitiveMap.get(primitiveId)!;
        return surfaceContainsPoint(primitive.inwardSurface, pointFor(footprint, firstEdge, 1, wallBottomY));
      })!, wallIdsByEdge.get(nextEdge.id)!.find((primitiveId) => {
        const primitive = primitiveMap.get(primitiveId)!;
        return surfaceContainsPoint(primitive.inwardSurface, pointFor(footprint, nextEdge, 0, wallBottomY));
      })!],
    ));
    for (let segment = 0; segment < ARENA_TRANSITION_SEGMENT_COUNT; segment += 1) {
      edges.push(seamEdge(
        firstUpper.sampleEdges[segment]![1],
        firstUpper.sampleEdges[segment + 1]![1],
        [firstUpper.primitiveIds[segment]!, nextUpper.primitiveIds[segment]!],
      ));
    }
    addSeam(id, kind, 'joined', null, edges);
  }

  for (const goal of ['blue', 'orange'] as const) {
    const end = spec.goal.ends.find(({ zDirection }) => (goal === 'blue' ? -1 : 1) === zDirection)!;
    const approachId = floorApproachIds.get(goal)!;
    const innerZ = end.zDirection * (spec.halfLength - profiles.floorWall.run);
    addSeam(
      `seam.floor-mouth-approach.${goal}`,
      'floor-lower',
      'joined',
      null,
      [seamEdge(
        vector3(-openingHalfWidth, spec.floorY, innerZ),
        vector3(openingHalfWidth, spec.floorY, innerZ),
        ['field.floor.center', approachId],
      )],
    );

    for (const jamb of jambRecords.filter((record) => record.goal === goal)) {
      const edges: ResolvedArenaSeamEdge[] = [];
      for (let segment = 0; segment < ARENA_TRANSITION_SEGMENT_COUNT; segment += 1) {
        edges.push(
          seamEdge(jamb.curvePoints[segment]!, jamb.curvePoints[segment + 1]!, [
            jamb.lowerStrip.primitiveIds[segment]!, jamb.primitiveIds[segment]!,
          ]),
          seamEdge(jamb.floorPoints[segment]!, jamb.floorPoints[segment + 1]!, [
            jamb.primitiveIds[segment]!, jamb.floorPrimitiveId,
          ]),
        );
        if (segment > 0) {
          edges.push(seamEdge(jamb.curvePoints[segment]!, jamb.floorPoints[segment]!, [
            jamb.primitiveIds[segment - 1]!, jamb.primitiveIds[segment]!,
          ]));
        }
      }
      const x = jamb.side === 'east' ? openingHalfWidth : -openingHalfWidth;
      edges.push(seamEdge(
        vector3(x, end.opening.height, end.goalLineZ),
        vector3(x, wallTopY, end.goalLineZ),
        [jamb.lowerStrip.wallId, `field.wall.${goal}-end.opening-top`],
      ));
      addSeam(`seam.goal-jamb.${goal}.${jamb.side}`, 'goal-jamb', 'joined', null, edges);
    }

    addSeam(
      `seam.goal-floor.${goal}`,
      'goal-floor',
      'joined',
      null,
      [
        seamEdge(
          vector3(-openingHalfWidth, spec.floorY, end.goalLineZ),
          vector3(-openingHalfWidth, spec.floorY, end.backWallZ),
          [`goal.${goal}.floor`, `goal.${goal}.side-west`],
        ),
        seamEdge(
          vector3(openingHalfWidth, spec.floorY, end.goalLineZ),
          vector3(openingHalfWidth, spec.floorY, end.backWallZ),
          [`goal.${goal}.floor`, `goal.${goal}.side-east`],
        ),
      ],
    );
    addSeam(
      `seam.goal-roof.${goal}`,
      'goal-roof',
      'joined',
      null,
      [
        seamEdge(
          vector3(-openingHalfWidth, end.opening.height, end.goalLineZ),
          vector3(-openingHalfWidth, end.opening.height, end.backWallZ),
          [`goal.${goal}.side-west`, `goal.${goal}.roof`],
        ),
        seamEdge(
          vector3(openingHalfWidth, end.opening.height, end.goalLineZ),
          vector3(openingHalfWidth, end.opening.height, end.backWallZ),
          [`goal.${goal}.side-east`, `goal.${goal}.roof`],
        ),
      ],
    );
    addSeam(
      `seam.goal-back.${goal}`,
      'goal-back',
      'joined',
      null,
      [
        seamEdge(
          vector3(-openingHalfWidth, spec.floorY, end.backWallZ),
          vector3(openingHalfWidth, spec.floorY, end.backWallZ),
          [`goal.${goal}.floor`, `goal.${goal}.back`],
        ),
        seamEdge(
          vector3(-openingHalfWidth, spec.floorY, end.backWallZ),
          vector3(-openingHalfWidth, end.opening.height, end.backWallZ),
          [`goal.${goal}.side-west`, `goal.${goal}.back`],
        ),
        seamEdge(
          vector3(openingHalfWidth, spec.floorY, end.backWallZ),
          vector3(openingHalfWidth, end.opening.height, end.backWallZ),
          [`goal.${goal}.side-east`, `goal.${goal}.back`],
        ),
        seamEdge(
          vector3(-openingHalfWidth, end.opening.height, end.backWallZ),
          vector3(openingHalfWidth, end.opening.height, end.backWallZ),
          [`goal.${goal}.roof`, `goal.${goal}.back`],
        ),
      ],
    );
    addSeam(
      `seam.goal-aperture.${goal}`,
      'goal-aperture',
      'goal-aperture',
      `${goal}-goal`,
      [
        seamEdge(
          vector3(-openingHalfWidth, spec.floorY, end.goalLineZ),
          vector3(openingHalfWidth, spec.floorY, end.goalLineZ),
          [approachId, `goal.${goal}.floor`],
        ),
        seamEdge(
          vector3(-openingHalfWidth, spec.floorY, end.goalLineZ),
          vector3(-openingHalfWidth, wallBottomY, end.goalLineZ),
          [`goal.${goal}.side-west`, `field.goal-jamb.${goal}.west.segment-07`],
        ),
        seamEdge(
          vector3(-openingHalfWidth, wallBottomY, end.goalLineZ),
          vector3(-openingHalfWidth, end.opening.height, end.goalLineZ),
          [`goal.${goal}.side-west`, `field.wall.${goal}-end.west`],
        ),
        seamEdge(
          vector3(openingHalfWidth, spec.floorY, end.goalLineZ),
          vector3(openingHalfWidth, wallBottomY, end.goalLineZ),
          [`goal.${goal}.side-east`, `field.goal-jamb.${goal}.east.segment-07`],
        ),
        seamEdge(
          vector3(openingHalfWidth, wallBottomY, end.goalLineZ),
          vector3(openingHalfWidth, end.opening.height, end.goalLineZ),
          [`goal.${goal}.side-east`, `field.wall.${goal}-end.east`],
        ),
        seamEdge(
          vector3(-openingHalfWidth, end.opening.height, end.goalLineZ),
          vector3(openingHalfWidth, end.opening.height, end.goalLineZ),
          [`goal.${goal}.roof`, `field.wall.${goal}-end.opening-top`],
        ),
      ],
    );
  }

  const pairSeam = (firstId: string, secondId: string, axes: readonly ArenaMirrorAxis[]): void => {
    const first = seamMap.get(firstId);
    const second = seamMap.get(secondId);
    if (first === undefined || second === undefined) throw new TypeError(`Missing seam mirror pair ${firstId} <-> ${secondId}.`);
    first.mirroredSeamId = secondId;
    second.mirroredSeamId = firstId;
    first.mirrorAxes = [...axes];
    second.mirrorAxes = [...axes];
  };

  for (const prefix of ['seam.floor-lower', 'seam.lower-profile', 'seam.lower-wall'] as const) {
    pairSeam(`${prefix}.east`, `${prefix}.west`, ['x']);
    for (const [first, second] of [
      ['corner.blue-east', 'corner.orange-west'],
      ['corner.blue-west', 'corner.orange-east'],
      ['blue-end.east', 'orange-end.west'],
      ['blue-end.west', 'orange-end.east'],
    ] as const) pairSeam(`${prefix}.${first}`, `${prefix}.${second}`, ['x', 'z']);
  }
  for (const prefix of ['seam.wall-upper', 'seam.upper-profile', 'seam.upper-ceiling'] as const) {
    pairSeam(`${prefix}.east`, `${prefix}.west`, ['x']);
    pairSeam(`${prefix}.blue-end`, `${prefix}.orange-end`, ['z']);
    pairSeam(`${prefix}.corner.blue-east`, `${prefix}.corner.orange-west`, ['x', 'z']);
    pairSeam(`${prefix}.corner.blue-west`, `${prefix}.corner.orange-east`, ['x', 'z']);
  }
  for (const prefix of ['seam.side-corner', 'seam.corner-end'] as const) {
    pairSeam(`${prefix}.blue-east`, `${prefix}.orange-west`, ['x', 'z']);
    pairSeam(`${prefix}.blue-west`, `${prefix}.orange-east`, ['x', 'z']);
  }
  pairSeam('seam.floor-mouth-approach.blue', 'seam.floor-mouth-approach.orange', ['z']);
  pairSeam('seam.goal-jamb.blue.east', 'seam.goal-jamb.orange.west', ['x', 'z']);
  pairSeam('seam.goal-jamb.blue.west', 'seam.goal-jamb.orange.east', ['x', 'z']);
  pairSeam('seam.goal-floor.blue', 'seam.goal-floor.orange', ['z']);
  pairSeam('seam.goal-roof.blue', 'seam.goal-roof.orange', ['z']);
  pairSeam('seam.goal-back.blue', 'seam.goal-back.orange', ['z']);
  pairSeam('seam.goal-aperture.blue', 'seam.goal-aperture.orange', ['z']);
  const unpairedSeams = seams.filter(({ mirroredSeamId }) => mirroredSeamId.length === 0);
  if (unpairedSeams.length > 0) throw new TypeError(`Unpaired arena seams: ${unpairedSeams.map(({ id }) => id).join(', ')}`);

  const finalizedPrimitives: ResolvedArenaBoundaryPrimitive[] = primitives.map((primitive) => ({
    ...primitive,
    mirrorAxes: [...primitive.mirrorAxes],
    inwardSurface: {
      ...primitive.inwardSurface,
      seamIds: [...(seamMembership.get(primitive.id) ?? [])].sort(),
    },
  })).sort((left, right) => left.id.localeCompare(right.id));

  const finalizedSurfaces: ResolvedArenaSurface[] = spec.surfaces.map((surface) => {
    const primitiveIds = finalizedPrimitives
      .filter(({ surfaceId }) => surfaceId === surface.id)
      .map(({ id }) => id);
    return {
      ...surface,
      primitiveIds,
      materialRoles: surfaceMaterialRoles(surface, finalizedPrimitives),
    };
  }).sort((left, right) => left.id.localeCompare(right.id));

  const finalizedSeams: ResolvedArenaSeam[] = seams.map((seam) => ({
    ...seam,
    mirrorAxes: [...seam.mirrorAxes],
    edges: seam.edges.map((edge) => ({
      endpoints: edge.endpoints,
      primitiveIds: [...edge.primitiveIds],
    })),
  })).sort((left, right) => left.id.localeCompare(right.id));

  const goals: ResolvedArenaGoalRegion[] = spec.goal.ends.map<ResolvedArenaGoalRegion>((end) => {
    const goal: 'blue' | 'orange' = end.zDirection < 0 ? 'blue' : 'orange';
    const goalId: 'blue-goal' | 'orange-goal' = goal === 'blue' ? 'blue-goal' : 'orange-goal';
    const mirroredGoalId: 'blue-goal' | 'orange-goal' = goal === 'blue' ? 'orange-goal' : 'blue-goal';
    return {
      id: goalId,
      defendingTeam: goal,
      mirroredGoalId,
      zDirection: end.zDirection,
      goalLineZ: end.goalLineZ,
      backWallZ: end.backWallZ,
      opening: {
        centerX: 0,
        bottomY: 0,
        width: end.opening.width,
        height: end.opening.height,
      },
      bounds: {
        min: vector3(
          -openingHalfWidth,
          spec.floorY,
          Math.min(end.goalLineZ, end.backWallZ),
        ),
        max: vector3(
          openingHalfWidth,
          end.opening.height,
          Math.max(end.goalLineZ, end.backWallZ),
        ),
      },
      surfaceIds: [...end.surfaceIds].sort(),
      primitiveIds: [...goalSurfacePrimitiveIds.get(goal)!].sort(),
      apertureSeamId: `seam.goal-aperture.${goal}`,
    };
  }).sort((left, right) => left.id.localeCompare(right.id));

  const geometryWithoutFingerprint: ResolvedArenaGeometry = {
    identity: {
      sourceVersion: spec.version,
      primitiveSchemaVersion: ARENA_PRIMITIVE_SCHEMA_VERSION,
      fingerprint: '',
    },
    units: 'meters',
    shellThickness: ARENA_SHELL_THICKNESS_METERS,
    bounds: {
      min: vector3(-spec.halfWidth, spec.floorY, -spec.halfLength),
      max: vector3(spec.halfWidth, spec.ceilingHeight, spec.halfLength),
    },
    enclosureBounds: {
      min: vector3(-spec.halfWidth, spec.floorY, spec.goal.ends[0]!.backWallZ),
      max: vector3(spec.halfWidth, spec.ceilingHeight, spec.goal.ends[1]!.backWallZ),
    },
    profiles,
    cornerCuts: resolvedCornerCuts(spec),
    goals,
    surfaces: finalizedSurfaces,
    primitives: finalizedPrimitives,
    seams: finalizedSeams,
    topology: {
      closedCollisionVolume: true,
      unmatchedApertureIds: ['blue-goal', 'orange-goal'],
      unmatchedSeamIds: ['seam.goal-aperture.blue', 'seam.goal-aperture.orange'],
    },
  };
  const geometry: ResolvedArenaGeometry = {
    ...geometryWithoutFingerprint,
    identity: {
      ...geometryWithoutFingerprint.identity,
      fingerprint: computeArenaGeometryFingerprint(geometryWithoutFingerprint),
    },
  };
  validateResolvedArenaGeometry(geometry);
  return deepFreeze(geometry);
}

/** Immutable singleton used by production; the legacy name is an identity alias only. */
export const RESOLVED_ARENA_GEOMETRY = resolveArenaGeometry(ARENA_GEOMETRY_SPEC);
export const ARENA_COLLISION_GEOMETRY = RESOLVED_ARENA_GEOMETRY;

/** @deprecated Use resolveArenaGeometry. Kept only for source compatibility during the cutover. */
export const resolveArenaCollisionGeometry = resolveArenaGeometry;
/** @deprecated Use ResolvedArenaBoundaryPrimitive. */
export type ArenaCollisionPrimitive = ResolvedArenaBoundaryPrimitive;
/** @deprecated Use ResolvedArenaGeometry. */
export type ArenaCollisionGeometry = ResolvedArenaGeometry;
