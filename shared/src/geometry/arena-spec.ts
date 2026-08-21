import { TUNING_IDS } from '../tuning/model.js';
import type { Team } from '../types/room.js';

export const ARENA_GEOMETRY_VERSION = 1 as const;
export const ARENA_WIDTH_METERS = 81.92 as const;
export const ARENA_LENGTH_METERS = 102.4 as const;
export const ARENA_HALF_WIDTH_METERS = 40.96 as const;
export const ARENA_HALF_LENGTH_METERS = 51.2 as const;
export const ARENA_CEILING_HEIGHT_METERS = 20.44 as const;
export const ARENA_CORNER_CUT_LENGTH_METERS = 11.52 as const;
export const ARENA_CORNER_CUT_ANGLE_DEGREES = 45 as const;
export const ARENA_FLOOR_RAMP_HEIGHT_METERS = 2.56 as const;
export const GOAL_OPENING_WIDTH_METERS = 17.86 as const;
export const GOAL_OPENING_HEIGHT_METERS = 6.43 as const;
export const GOAL_DEPTH_METERS = 8.8 as const;

export type SurfaceCapability = 'core' | 'advanced';
export type SurfaceSemanticKind =
  | 'floor'
  | 'floor-wall-ramp'
  | 'wall'
  | 'horizontal-corner'
  | 'wall-ceiling-transition'
  | 'ceiling'
  | 'goal-floor'
  | 'goal-side-wall'
  | 'goal-roof'
  | 'goal-back-wall';

export interface ArenaSurfaceDescriptor {
  readonly id: string;
  readonly kind: SurfaceSemanticKind;
  readonly capability: SurfaceCapability;
  /** True when this semantic surface participates in the closed exterior shell. */
  readonly closesExterior: boolean;
  readonly mirroredSurfaceId: string | null;
}

export interface GoalOpeningDescriptor {
  readonly centerX: 0;
  readonly bottomY: 0;
  readonly width: 17.86;
  readonly height: 6.43;
}

export interface GoalEndDescriptor {
  readonly id: 'blue-goal' | 'orange-goal';
  readonly defendingTeam: Team;
  readonly zDirection: -1 | 1;
  readonly goalLineZ: number;
  readonly backWallZ: number;
  readonly opening: GoalOpeningDescriptor;
  readonly surfaceIds: readonly string[];
}

export interface CornerCutDescriptor {
  readonly id: string;
  readonly xSign: -1 | 1;
  readonly zSign: -1 | 1;
  readonly horizontalLength: 11.52;
  readonly angleDegrees: 45;
  readonly surfaceId: string;
}

export interface ArenaTopologyMetadata {
  readonly closedCollisionVolume: true;
  readonly solidGoalInteriors: true;
  readonly goalOpeningsTerminateInsideClosedInteriors: true;
  readonly fieldBoundaryLoopClosed: true;
  readonly boundarySurfaceIds: readonly string[];
}

export interface ArenaRegistryReferences {
  /** Values live in the registry; this geometry module intentionally stores only IDs. */
  readonly support: readonly string[];
  readonly boostPads: readonly string[];
  readonly camera: readonly string[];
}

export interface ArenaGeometrySpec {
  readonly version: typeof ARENA_GEOMETRY_VERSION;
  readonly units: 'meters';
  readonly axes: Readonly<{
    width: 'x';
    up: 'y';
    length: 'z';
  }>;
  readonly center: readonly [0, 0, 0];
  readonly floorY: 0;
  readonly width: 81.92;
  readonly length: 102.4;
  readonly halfWidth: 40.96;
  readonly halfLength: 51.2;
  readonly ceilingHeight: 20.44;
  readonly cornerCuts: readonly CornerCutDescriptor[];
  readonly floorWallRamp: Readonly<{ readonly height: 2.56 }>;
  readonly goal: Readonly<{
    readonly openingWidth: 17.86;
    readonly openingHeight: 6.43;
    readonly depth: 8.8;
    readonly ends: readonly GoalEndDescriptor[];
  }>;
  readonly surfaces: readonly ArenaSurfaceDescriptor[];
  readonly topology: ArenaTopologyMetadata;
  readonly registryReferences: ArenaRegistryReferences;
}

export type ArenaSpecValidationCode =
  | 'invalid-structure'
  | 'non-finite-dimension'
  | 'dimension-mismatch'
  | 'invalid-goal-mirror'
  | 'invalid-corner-table'
  | 'duplicate-surface-id'
  | 'invalid-surface-reference'
  | 'open-topology'
  | 'invalid-registry-reference';

export class InvalidArenaGeometrySpecError extends Error {
  readonly code: ArenaSpecValidationCode;

  constructor(code: ArenaSpecValidationCode, message: string) {
    super(`[ArenaGeometry:${code}] ${message}`);
    this.name = 'InvalidArenaGeometrySpecError';
    this.code = code;
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function surface(
  id: string,
  kind: SurfaceSemanticKind,
  capability: SurfaceCapability,
  mirroredSurfaceId: string | null,
): ArenaSurfaceDescriptor {
  return { id, kind, capability, closesExterior: true, mirroredSurfaceId };
}

const SURFACES = [
  surface('field.floor', 'floor', 'core', null),
  surface('field.ramp.west', 'floor-wall-ramp', 'core', 'field.ramp.east'),
  surface('field.ramp.east', 'floor-wall-ramp', 'core', 'field.ramp.west'),
  surface('field.ramp.blue-end', 'floor-wall-ramp', 'core', 'field.ramp.orange-end'),
  surface('field.ramp.orange-end', 'floor-wall-ramp', 'core', 'field.ramp.blue-end'),
  surface('field.wall.west', 'wall', 'advanced', 'field.wall.east'),
  surface('field.wall.east', 'wall', 'advanced', 'field.wall.west'),
  surface('field.wall.blue-end', 'wall', 'advanced', 'field.wall.orange-end'),
  surface('field.wall.orange-end', 'wall', 'advanced', 'field.wall.blue-end'),
  surface('field.corner.blue-west', 'horizontal-corner', 'advanced', 'field.corner.orange-east'),
  surface('field.corner.blue-east', 'horizontal-corner', 'advanced', 'field.corner.orange-west'),
  surface('field.corner.orange-west', 'horizontal-corner', 'advanced', 'field.corner.blue-east'),
  surface('field.corner.orange-east', 'horizontal-corner', 'advanced', 'field.corner.blue-west'),
  surface('field.transition.west-ceiling', 'wall-ceiling-transition', 'advanced', 'field.transition.east-ceiling'),
  surface('field.transition.east-ceiling', 'wall-ceiling-transition', 'advanced', 'field.transition.west-ceiling'),
  surface('field.transition.blue-ceiling', 'wall-ceiling-transition', 'advanced', 'field.transition.orange-ceiling'),
  surface('field.transition.orange-ceiling', 'wall-ceiling-transition', 'advanced', 'field.transition.blue-ceiling'),
  surface('field.ceiling', 'ceiling', 'advanced', null),
  surface('goal.blue.floor', 'goal-floor', 'core', 'goal.orange.floor'),
  surface('goal.blue.side-west', 'goal-side-wall', 'core', 'goal.orange.side-east'),
  surface('goal.blue.side-east', 'goal-side-wall', 'core', 'goal.orange.side-west'),
  surface('goal.blue.roof', 'goal-roof', 'core', 'goal.orange.roof'),
  surface('goal.blue.back', 'goal-back-wall', 'core', 'goal.orange.back'),
  surface('goal.orange.floor', 'goal-floor', 'core', 'goal.blue.floor'),
  surface('goal.orange.side-west', 'goal-side-wall', 'core', 'goal.blue.side-east'),
  surface('goal.orange.side-east', 'goal-side-wall', 'core', 'goal.blue.side-west'),
  surface('goal.orange.roof', 'goal-roof', 'core', 'goal.blue.roof'),
  surface('goal.orange.back', 'goal-back-wall', 'core', 'goal.blue.back'),
] as const;

const BLUE_GOAL_SURFACES = [
  'goal.blue.floor',
  'goal.blue.side-west',
  'goal.blue.side-east',
  'goal.blue.roof',
  'goal.blue.back',
] as const;

const ORANGE_GOAL_SURFACES = [
  'goal.orange.floor',
  'goal.orange.side-west',
  'goal.orange.side-east',
  'goal.orange.roof',
  'goal.orange.back',
] as const;

const OPENING: GoalOpeningDescriptor = {
  centerX: 0,
  bottomY: 0,
  width: GOAL_OPENING_WIDTH_METERS,
  height: GOAL_OPENING_HEIGHT_METERS,
};

const GOAL_ENDS: readonly GoalEndDescriptor[] = [
  {
    id: 'blue-goal',
    defendingTeam: 'blue',
    zDirection: -1,
    goalLineZ: -ARENA_LENGTH_METERS / 2,
    backWallZ: -(ARENA_LENGTH_METERS / 2 + GOAL_DEPTH_METERS),
    opening: OPENING,
    surfaceIds: BLUE_GOAL_SURFACES,
  },
  {
    id: 'orange-goal',
    defendingTeam: 'orange',
    zDirection: 1,
    goalLineZ: ARENA_LENGTH_METERS / 2,
    backWallZ: ARENA_LENGTH_METERS / 2 + GOAL_DEPTH_METERS,
    opening: OPENING,
    surfaceIds: ORANGE_GOAL_SURFACES,
  },
];

const CORNER_CUTS: readonly CornerCutDescriptor[] = [
  { id: 'blue-west', xSign: -1, zSign: -1, horizontalLength: ARENA_CORNER_CUT_LENGTH_METERS, angleDegrees: ARENA_CORNER_CUT_ANGLE_DEGREES, surfaceId: 'field.corner.blue-west' },
  { id: 'blue-east', xSign: 1, zSign: -1, horizontalLength: ARENA_CORNER_CUT_LENGTH_METERS, angleDegrees: ARENA_CORNER_CUT_ANGLE_DEGREES, surfaceId: 'field.corner.blue-east' },
  { id: 'orange-west', xSign: -1, zSign: 1, horizontalLength: ARENA_CORNER_CUT_LENGTH_METERS, angleDegrees: ARENA_CORNER_CUT_ANGLE_DEGREES, surfaceId: 'field.corner.orange-west' },
  { id: 'orange-east', xSign: 1, zSign: 1, horizontalLength: ARENA_CORNER_CUT_LENGTH_METERS, angleDegrees: ARENA_CORNER_CUT_ANGLE_DEGREES, surfaceId: 'field.corner.orange-east' },
];

const REGISTRY_REFERENCES: ArenaRegistryReferences = {
  support: [
    TUNING_IDS.support.contactPoints,
    TUNING_IDS.support.rayDistance,
    TUNING_IDS.support.normalAngleThresholdDegrees,
  ],
  boostPads: [
    ...TUNING_IDS.boostPads.largePositions,
    TUNING_IDS.boostPads.largeSensorHalfExtents,
    ...TUNING_IDS.boostPads.smallPositions,
    TUNING_IDS.boostPads.smallSensorHalfExtents,
  ],
  camera: [
    TUNING_IDS.camera.ball.distance,
    TUNING_IDS.camera.ball.height,
    TUNING_IDS.camera.ball.lookAhead,
    TUNING_IDS.camera.ball.fieldOfViewDegrees,
    TUNING_IDS.camera.spring.distance,
    TUNING_IDS.camera.spring.height,
    TUNING_IDS.camera.spring.stiffness,
    TUNING_IDS.camera.spring.damping,
    TUNING_IDS.camera.spring.lookAhead,
    TUNING_IDS.camera.spring.fieldOfViewDegrees,
  ],
};

/** Single exact metric source for authoritative collision and visible boundaries. */
export const ARENA_GEOMETRY_SPEC: ArenaGeometrySpec = deepFreeze({
  version: ARENA_GEOMETRY_VERSION,
  units: 'meters',
  axes: { width: 'x', up: 'y', length: 'z' },
  center: [0, 0, 0],
  floorY: 0,
  width: ARENA_WIDTH_METERS,
  length: ARENA_LENGTH_METERS,
  halfWidth: ARENA_HALF_WIDTH_METERS,
  halfLength: ARENA_HALF_LENGTH_METERS,
  ceilingHeight: ARENA_CEILING_HEIGHT_METERS,
  cornerCuts: CORNER_CUTS,
  floorWallRamp: { height: ARENA_FLOOR_RAMP_HEIGHT_METERS },
  goal: {
    openingWidth: GOAL_OPENING_WIDTH_METERS,
    openingHeight: GOAL_OPENING_HEIGHT_METERS,
    depth: GOAL_DEPTH_METERS,
    ends: GOAL_ENDS,
  },
  surfaces: SURFACES,
  topology: {
    closedCollisionVolume: true,
    solidGoalInteriors: true,
    goalOpeningsTerminateInsideClosedInteriors: true,
    fieldBoundaryLoopClosed: true,
    boundarySurfaceIds: SURFACES.map(({ id }) => id),
  },
  registryReferences: REGISTRY_REFERENCES,
});

function fail(code: ArenaSpecValidationCode, message: string): never {
  throw new InvalidArenaGeometrySpecError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactFinite(value: unknown, expected: number, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail('non-finite-dimension', `${field} must be finite.`);
  }
  if (value !== expected) fail('dimension-mismatch', `${field} must equal ${expected}.`);
  return value;
}

/** Structural validator used by server/client startup before consuming a supplied spec. */
export function validateArenaGeometrySpec(candidate: unknown): asserts candidate is ArenaGeometrySpec {
  if (!isRecord(candidate)) fail('invalid-structure', 'Arena geometry must be an object.');
  if (candidate.version !== ARENA_GEOMETRY_VERSION || candidate.units !== 'meters') {
    fail('invalid-structure', 'Unsupported arena geometry version or unit system.');
  }

  const assertExactStringSet = (
    value: unknown,
    expected: readonly string[],
    field: string,
    invalidCode: ArenaSpecValidationCode = 'invalid-surface-reference',
    incompleteCode: ArenaSpecValidationCode = invalidCode,
  ): readonly string[] => {
    if (!Array.isArray(value)
      || value.some((entry) => typeof entry !== 'string' || entry.trim().length === 0)) {
      fail(invalidCode, `${field} must contain non-empty string IDs.`);
    }
    const actualIds = value as string[];
    const actual = new Set(actualIds);
    const expectedIds = new Set(expected);
    if (actual.size !== actualIds.length || actualIds.some((id) => !expectedIds.has(id))) {
      fail(invalidCode, `${field} must contain only unique known v${ARENA_GEOMETRY_VERSION} IDs.`);
    }
    if (actual.size !== expectedIds.size || expected.some((id) => !actual.has(id))) {
      fail(incompleteCode, `${field} must contain the complete v${ARENA_GEOMETRY_VERSION} ID set.`);
    }
    return actualIds;
  };

  if (!isRecord(candidate.axes)
    || candidate.axes.width !== 'x'
    || candidate.axes.up !== 'y'
    || candidate.axes.length !== 'z') {
    fail('invalid-structure', 'Arena axes must map width/up/length to x/y/z.');
  }
  if (!Array.isArray(candidate.center)
    || candidate.center.length !== 3
    || candidate.center[0] !== 0
    || candidate.center[1] !== 0
    || candidate.center[2] !== 0) {
    fail('invalid-structure', 'Arena center must be the exact [0, 0, 0] origin.');
  }
  exactFinite(candidate.floorY, 0, 'floorY');
  exactFinite(candidate.width, ARENA_WIDTH_METERS, 'width');
  exactFinite(candidate.length, ARENA_LENGTH_METERS, 'length');
  exactFinite(candidate.halfWidth, ARENA_WIDTH_METERS / 2, 'halfWidth');
  exactFinite(candidate.halfLength, ARENA_LENGTH_METERS / 2, 'halfLength');
  exactFinite(candidate.ceilingHeight, ARENA_CEILING_HEIGHT_METERS, 'ceilingHeight');
  if (!isRecord(candidate.floorWallRamp)) fail('invalid-structure', 'floorWallRamp is required.');
  exactFinite(candidate.floorWallRamp.height, ARENA_FLOOR_RAMP_HEIGHT_METERS, 'floorWallRamp.height');

  if (!isRecord(candidate.goal) || !Array.isArray(candidate.goal.ends)) {
    fail('invalid-structure', 'Goal dimensions and two end descriptors are required.');
  }
  exactFinite(candidate.goal.openingWidth, GOAL_OPENING_WIDTH_METERS, 'goal.openingWidth');
  exactFinite(candidate.goal.openingHeight, GOAL_OPENING_HEIGHT_METERS, 'goal.openingHeight');
  exactFinite(candidate.goal.depth, GOAL_DEPTH_METERS, 'goal.depth');
  if (candidate.goal.ends.length !== 2) fail('invalid-goal-mirror', 'Exactly two mirrored goals are required.');
  const [blue, orange] = candidate.goal.ends;
  if (!isRecord(blue) || !isRecord(orange)
    || blue.id !== 'blue-goal' || blue.defendingTeam !== 'blue' || blue.zDirection !== -1
    || orange.id !== 'orange-goal' || orange.defendingTeam !== 'orange' || orange.zDirection !== 1) {
    fail('invalid-goal-mirror', 'Goal end identities, teams, and directions are invalid.');
  }

  const validateOpening = (opening: unknown, field: string): void => {
    if (!isRecord(opening)) fail('invalid-goal-mirror', `${field} is required.`);
    exactFinite(opening.centerX, 0, `${field}.centerX`);
    exactFinite(opening.bottomY, 0, `${field}.bottomY`);
    exactFinite(opening.width, GOAL_OPENING_WIDTH_METERS, `${field}.width`);
    exactFinite(opening.height, GOAL_OPENING_HEIGHT_METERS, `${field}.height`);
  };
  validateOpening(blue.opening, 'blueGoal.opening');
  validateOpening(orange.opening, 'orangeGoal.opening');

  const blueGoalLineZ = exactFinite(blue.goalLineZ, -ARENA_HALF_LENGTH_METERS, 'blueGoal.goalLineZ');
  const orangeGoalLineZ = exactFinite(orange.goalLineZ, ARENA_HALF_LENGTH_METERS, 'orangeGoal.goalLineZ');
  const blueBackWallZ = exactFinite(
    blue.backWallZ,
    -(ARENA_HALF_LENGTH_METERS + GOAL_DEPTH_METERS),
    'blueGoal.backWallZ',
  );
  const orangeBackWallZ = exactFinite(
    orange.backWallZ,
    ARENA_HALF_LENGTH_METERS + GOAL_DEPTH_METERS,
    'orangeGoal.backWallZ',
  );
  if (blueGoalLineZ !== -orangeGoalLineZ || blueBackWallZ !== -orangeBackWallZ) {
    fail('invalid-goal-mirror', 'Goal planes and backs must mirror through arena center.');
  }

  if (!Array.isArray(candidate.cornerCuts) || candidate.cornerCuts.length !== CORNER_CUTS.length) {
    fail('invalid-corner-table', 'Exactly four corner cuts are required.');
  }
  const expectedCorners = new Map(CORNER_CUTS.map((corner) => [corner.id, corner] as const));
  const seenCornerIds = new Set<string>();
  const cornerSigns = new Set<string>();
  for (const corner of candidate.cornerCuts) {
    if (!isRecord(corner) || typeof corner.id !== 'string') {
      fail('invalid-corner-table', 'Every corner requires a canonical semantic ID.');
    }
    const expected = expectedCorners.get(corner.id);
    if (!expected || seenCornerIds.has(corner.id)
      || corner.xSign !== expected.xSign
      || corner.zSign !== expected.zSign
      || corner.surfaceId !== expected.surfaceId) {
      fail('invalid-corner-table', `Corner ${corner.id} does not match the canonical v1 table.`);
    }
    exactFinite(corner.horizontalLength, ARENA_CORNER_CUT_LENGTH_METERS, 'corner.horizontalLength');
    exactFinite(corner.angleDegrees, ARENA_CORNER_CUT_ANGLE_DEGREES, 'corner.angleDegrees');
    seenCornerIds.add(corner.id);
    cornerSigns.add(`${corner.xSign},${corner.zSign}`);
  }
  if (cornerSigns.size !== CORNER_CUTS.length) {
    fail('invalid-corner-table', 'Corner sign combinations must be unique.');
  }

  if (!Array.isArray(candidate.surfaces) || candidate.surfaces.length !== SURFACES.length) {
    fail('invalid-structure', 'The complete v1 semantic surface table is required.');
  }
  const expectedSurfaces = new Map(SURFACES.map((descriptor) => [descriptor.id, descriptor] as const));
  const surfacesById = new Map<string, Record<string, unknown>>();
  for (const descriptor of candidate.surfaces) {
    if (!isRecord(descriptor) || typeof descriptor.id !== 'string' || descriptor.id.trim().length === 0) {
      fail('invalid-structure', 'Every surface requires a non-empty semantic ID.');
    }
    if (surfacesById.has(descriptor.id)) {
      fail('duplicate-surface-id', `Surface ID ${descriptor.id} appears more than once.`);
    }
    const expected = expectedSurfaces.get(descriptor.id);
    if (!expected) {
      fail('invalid-surface-reference', `Surface ${descriptor.id} is not part of the v1 arena.`);
    }
    if (descriptor.kind !== expected.kind
      || descriptor.capability !== expected.capability
      || descriptor.closesExterior !== expected.closesExterior
      || descriptor.mirroredSurfaceId !== expected.mirroredSurfaceId) {
      fail('invalid-structure', `Surface ${descriptor.id} does not match its canonical semantic descriptor.`);
    }
    surfacesById.set(descriptor.id, descriptor);
  }
  for (const [id, descriptor] of surfacesById) {
    const mirror = descriptor.mirroredSurfaceId;
    if (mirror !== null) {
      const counterpart = typeof mirror === 'string' ? surfacesById.get(mirror) : undefined;
      if (counterpart?.mirroredSurfaceId !== id) {
        fail('invalid-surface-reference', `Surface ${id} has a non-reciprocal mirror.`);
      }
    }
  }

  assertExactStringSet(blue.surfaceIds, BLUE_GOAL_SURFACES, 'blueGoal.surfaceIds');
  assertExactStringSet(orange.surfaceIds, ORANGE_GOAL_SURFACES, 'orangeGoal.surfaceIds');
  for (const corner of CORNER_CUTS) {
    if (surfacesById.get(corner.surfaceId)?.kind !== 'horizontal-corner') {
      fail('invalid-surface-reference', `Corner ${corner.id} must reference a horizontal-corner surface.`);
    }
  }

  if (!isRecord(candidate.topology)
    || candidate.topology.closedCollisionVolume !== true
    || candidate.topology.solidGoalInteriors !== true
    || candidate.topology.goalOpeningsTerminateInsideClosedInteriors !== true
    || candidate.topology.fieldBoundaryLoopClosed !== true) {
    fail('open-topology', 'Topology must declare a closed field and solid goal interiors.');
  }
  assertExactStringSet(
    candidate.topology.boundarySurfaceIds,
    SURFACES.map(({ id }) => id),
    'topology.boundarySurfaceIds',
    'invalid-surface-reference',
    'open-topology',
  );

  if (!isRecord(candidate.registryReferences)) {
    fail('invalid-registry-reference', 'Registry references are required.');
  }
  for (const group of ['support', 'boostPads', 'camera'] as const) {
    assertExactStringSet(
      candidate.registryReferences[group],
      REGISTRY_REFERENCES[group],
      `registryReferences.${group}`,
      'invalid-registry-reference',
    );
  }
}

export function isArenaGeometrySpec(candidate: unknown): candidate is ArenaGeometrySpec {
  try {
    validateArenaGeometrySpec(candidate);
    return true;
  } catch (error) {
    if (error instanceof InvalidArenaGeometrySpecError) return false;
    throw error;
  }
}

validateArenaGeometrySpec(ARENA_GEOMETRY_SPEC);
