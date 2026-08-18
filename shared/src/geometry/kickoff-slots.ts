import { TUNING_IDS } from '../tuning/model.js';
import type { Team } from '../types/room.js';

export type Vector3Tuple = readonly [number, number, number];
export type QuaternionTuple = readonly [number, number, number, number];

export const KICKOFF_SLOT_INDEXES = Object.freeze([0, 1, 2, 3] as const);
export type KickoffSlotIndex = (typeof KICKOFF_SLOT_INDEXES)[number];
export type KickoffSlotId = `${Team}-${KickoffSlotIndex}`;

export const KICKOFF_SLOT_COUNT_PER_TEAM = 4 as const;
export const TEAM_FACING_MAX_ERROR_DEGREES = 1 as const;

/**
 * Registry IDs are explicit so every containment check uses the active,
 * room-pinned collider hypothesis rather than render-mesh dimensions.
 */
export const CAR_COLLIDER_TUNING_IDS = Object.freeze({
  length: TUNING_IDS.car.collider.length,
  width: TUNING_IDS.car.collider.width,
  height: TUNING_IDS.car.collider.height,
} as const);

export interface CarColliderTuningIds {
  readonly length: string;
  readonly width: string;
  readonly height: string;
}

export interface RegistryEntrySource {
  get(id: string): unknown;
}

export interface CarColliderDimensions {
  readonly length: number;
  readonly width: number;
  readonly height: number;
}

export interface KickoffSlot {
  readonly id: KickoffSlotId;
  readonly index: KickoffSlotIndex;
  readonly team: Team;
  readonly position: Vector3Tuple;
  /** Quaternion components are ordered [x, y, z, w]. */
  readonly rotation: QuaternionTuple;
}

export interface KickoffSlotTable {
  readonly blue: readonly KickoffSlot[];
  readonly orange: readonly KickoffSlot[];
}

export interface KickoffArenaBounds {
  readonly min: Vector3Tuple;
  readonly max: Vector3Tuple;
  /** Horizontal arena center used for mirroring and team-facing checks. */
  readonly center: Vector3Tuple;
}

export interface KickoffArenaDimensions {
  readonly width: number;
  readonly length: number;
  readonly ceilingHeight: number;
  readonly floorHeight?: number;
  readonly centerX?: number;
  readonly centerZ?: number;
}

export interface KickoffSlotValidationOptions {
  readonly arenaBounds: KickoffArenaBounds;
  readonly tuningRegistry: RegistryEntrySource;
  readonly colliderTuningIds?: CarColliderTuningIds;
}

export type KickoffSlotValidationCode =
  | 'invalid-table'
  | 'invalid-team-count'
  | 'invalid-slot'
  | 'duplicate-slot-id'
  | 'invalid-transform'
  | 'invalid-mirror'
  | 'invalid-facing'
  | 'outside-arena'
  | 'invalid-bounds'
  | 'invalid-collider-tuning';

export class InvalidKickoffSlotTableError extends Error {
  readonly code: KickoffSlotValidationCode;

  constructor(code: KickoffSlotValidationCode, message: string) {
    super(`[KickoffSlots:${code}] ${message}`);
    this.name = 'InvalidKickoffSlotTableError';
    this.code = code;
  }
}

const ORIGIN = Object.freeze([0, 0, 0] as const);
const QUATERNION_UNIT_TOLERANCE = 1e-9;
const CONTAINMENT_TOLERANCE_METERS = 1e-9;

function fail(code: KickoffSlotValidationCode, message: string): never {
  throw new InvalidKickoffSlotTableError(code, message);
}

function freezeVector3(values: readonly number[]): Vector3Tuple {
  return Object.freeze([values[0], values[1], values[2]]) as Vector3Tuple;
}

function freezeQuaternion(values: readonly number[]): QuaternionTuple {
  return Object.freeze([values[0], values[1], values[2], values[3]]) as QuaternionTuple;
}

function cleanNearZero(value: number): number {
  return Math.abs(value) < 1e-15 ? 0 : value;
}

function normalizeQuaternion(values: readonly number[]): QuaternionTuple {
  const magnitude = Math.hypot(values[0], values[1], values[2], values[3]);
  if (!Number.isFinite(magnitude) || magnitude === 0) {
    fail('invalid-transform', 'A slot rotation must be a finite, non-zero quaternion.');
  }

  return freezeQuaternion([
    cleanNearZero(values[0] / magnitude),
    cleanNearZero(values[1] / magnitude),
    cleanNearZero(values[2] / magnitude),
    cleanNearZero(values[3] / magnitude),
  ]);
}

function yawQuaternion(yawRadians: number): QuaternionTuple {
  const halfYaw = yawRadians / 2;
  return normalizeQuaternion([0, Math.sin(halfYaw), 0, Math.cos(halfYaw)]);
}

function makeSlot(
  team: Team,
  index: KickoffSlotIndex,
  position: Vector3Tuple,
  rotation: QuaternionTuple,
): KickoffSlot {
  return Object.freeze({
    id: `${team}-${index}` as KickoffSlotId,
    index,
    team,
    position: freezeVector3(position),
    rotation: freezeQuaternion(rotation),
  });
}

function rotationFacingCenter(position: Vector3Tuple): QuaternionTuple {
  const yaw = Math.atan2(-position[0], -position[2]);
  return yawQuaternion(yaw);
}

/**
 * Canonical staging slots. Coordinates are deliberately treated as configured
 * unique-spawn positions, not as a claim of exact Rocket League proximity.
 */
const CANONICAL_BLUE_POSITIONS = Object.freeze([
  freezeVector3([-16, 0.26, -34]),
  freezeVector3([16, 0.26, -34]),
  freezeVector3([-6, 0.26, -42]),
  freezeVector3([6, 0.26, -42]),
] as const);

export const BLUE_KICKOFF_SLOTS: readonly KickoffSlot[] = Object.freeze(
  KICKOFF_SLOT_INDEXES.map((index) => {
    const position = CANONICAL_BLUE_POSITIONS[index];
    return makeSlot('blue', index, position, rotationFacingCenter(position));
  }),
);

/**
 * Mirror one Blue slot through the arena center. A half-turn around world up is
 * left-multiplied onto the Blue rotation, matching yaw(PI) * rotationBlue.
 */
export function mirrorBlueKickoffSlot(
  blueSlot: KickoffSlot,
  arenaCenter: Vector3Tuple = ORIGIN,
): KickoffSlot {
  if (blueSlot.team !== 'blue') {
    fail('invalid-slot', `Only Blue slots can be mirrored; received ${blueSlot.team}.`);
  }

  const [x, y, z, w] = blueSlot.rotation;
  const mirroredRotation = normalizeQuaternion([z, w, -x, -y]);
  const mirroredPosition = freezeVector3([
    2 * arenaCenter[0] - blueSlot.position[0],
    blueSlot.position[1],
    2 * arenaCenter[2] - blueSlot.position[2],
  ]);

  return makeSlot('orange', blueSlot.index, mirroredPosition, mirroredRotation);
}

/** Orange is always derived from Blue; there is no independently authored table. */
export const ORANGE_KICKOFF_SLOTS: readonly KickoffSlot[] = Object.freeze(
  BLUE_KICKOFF_SLOTS.map((slot) => mirrorBlueKickoffSlot(slot)),
);

export const KICKOFF_SLOTS: KickoffSlotTable = Object.freeze({
  blue: BLUE_KICKOFF_SLOTS,
  orange: ORANGE_KICKOFF_SLOTS,
});

/** Build finite axis-aligned playable bounds from the shared arena dimensions. */
export function createKickoffArenaBounds(
  dimensions: KickoffArenaDimensions,
): KickoffArenaBounds {
  const floorHeight = dimensions.floorHeight ?? 0;
  const centerX = dimensions.centerX ?? 0;
  const centerZ = dimensions.centerZ ?? 0;
  const values = [
    dimensions.width,
    dimensions.length,
    dimensions.ceilingHeight,
    floorHeight,
    centerX,
    centerZ,
  ];

  if (!values.every(Number.isFinite)) {
    fail('invalid-bounds', 'Arena dimensions and center coordinates must be finite.');
  }
  if (dimensions.width <= 0 || dimensions.length <= 0 || dimensions.ceilingHeight <= 0) {
    fail('invalid-bounds', 'Arena width, length, and ceiling height must be positive.');
  }

  return Object.freeze({
    min: freezeVector3([
      centerX - dimensions.width / 2,
      floorHeight,
      centerZ - dimensions.length / 2,
    ]),
    max: freezeVector3([
      centerX + dimensions.width / 2,
      floorHeight + dimensions.ceilingHeight,
      centerZ + dimensions.length / 2,
    ]),
    center: freezeVector3([centerX, floorHeight, centerZ]),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function finiteTuple(
  value: unknown,
  length: number,
  label: string,
  code: KickoffSlotValidationCode,
): readonly number[] {
  if (!Array.isArray(value) || value.length !== length) {
    fail(code, `${label} must contain exactly ${length} numeric components.`);
  }
  if (!value.every((component) => typeof component === 'number' && Number.isFinite(component))) {
    fail(code, `${label} must contain only finite numeric components.`);
  }
  return value as readonly number[];
}

function validateBounds(bounds: KickoffArenaBounds): void {
  if (!isRecord(bounds)) {
    fail('invalid-bounds', 'Arena bounds must be an object.');
  }

  const min = finiteTuple(bounds.min, 3, 'Arena minimum bounds', 'invalid-bounds');
  const max = finiteTuple(bounds.max, 3, 'Arena maximum bounds', 'invalid-bounds');
  finiteTuple(bounds.center, 3, 'Arena center', 'invalid-bounds');

  for (let axis = 0; axis < 3; axis += 1) {
    if (min[axis] >= max[axis]) {
      fail('invalid-bounds', `Arena minimum must be below maximum on axis ${axis}.`);
    }
  }
}

function readScalarRegistryEntry(
  registry: RegistryEntrySource,
  id: string,
): number {
  let entry: unknown;
  try {
    entry = registry.get(id);
  } catch (error) {
    const reason = error instanceof Error ? ` ${error.message}` : '';
    fail('invalid-collider-tuning', `Unable to read collider tuning "${id}".${reason}`);
  }

  if (!isRecord(entry) || entry.kind !== 'scalar') {
    fail('invalid-collider-tuning', `Collider tuning "${id}" must be a scalar registry entry.`);
  }
  if (typeof entry.value !== 'number' || !Number.isFinite(entry.value) || entry.value <= 0) {
    fail('invalid-collider-tuning', `Collider tuning "${id}" must have a finite positive value.`);
  }

  if ('validatedRange' in entry) {
    const range = entry.validatedRange;
    if (!isRecord(range)
      || typeof range.min !== 'number'
      || typeof range.max !== 'number'
      || !Number.isFinite(range.min)
      || !Number.isFinite(range.max)
      || range.min > range.max
      || entry.value < range.min
      || entry.value > range.max) {
      fail(
        'invalid-collider-tuning',
        `Collider tuning "${id}" has an invalid range or an out-of-range value.`,
      );
    }
  }

  return entry.value;
}

/** Resolve independent length/width/height values from the active tuning snapshot. */
export function resolveCarColliderDimensions(
  registry: RegistryEntrySource,
  ids: CarColliderTuningIds = CAR_COLLIDER_TUNING_IDS,
): CarColliderDimensions {
  if (!isRecord(registry) || typeof registry.get !== 'function') {
    fail('invalid-collider-tuning', 'A registry snapshot with get(id) is required.');
  }

  const idValues = [ids.length, ids.width, ids.height];
  if (!idValues.every((id) => typeof id === 'string' && id.trim().length > 0)
    || new Set(idValues).size !== 3) {
    fail('invalid-collider-tuning', 'Collider length, width, and height IDs must be distinct.');
  }

  return Object.freeze({
    length: readScalarRegistryEntry(registry, ids.length),
    width: readScalarRegistryEntry(registry, ids.width),
    height: readScalarRegistryEntry(registry, ids.height),
  });
}

function quaternionMagnitude(rotation: readonly number[]): number {
  return Math.hypot(rotation[0], rotation[1], rotation[2], rotation[3]);
}

function rotateLocalForward(rotation: readonly number[]): Vector3Tuple {
  const magnitude = quaternionMagnitude(rotation);
  if (!Number.isFinite(magnitude) || magnitude === 0) {
    return freezeVector3([Number.NaN, Number.NaN, Number.NaN]);
  }

  const x = rotation[0] / magnitude;
  const y = rotation[1] / magnitude;
  const z = rotation[2] / magnitude;
  const w = rotation[3] / magnitude;

  return freezeVector3([
    2 * (x * z + w * y),
    2 * (y * z - w * x),
    1 - 2 * (x * x + y * y),
  ]);
}

/** Angular error between local +Z and the horizontal direction to arena center. */
export function centerFacingErrorDegrees(
  slot: Pick<KickoffSlot, 'position' | 'rotation'>,
  arenaCenter: Vector3Tuple = ORIGIN,
): number {
  const targetX = arenaCenter[0] - slot.position[0];
  const targetZ = arenaCenter[2] - slot.position[2];
  const targetLength = Math.hypot(targetX, targetZ);
  if (!Number.isFinite(targetLength) || targetLength === 0) {
    return Number.POSITIVE_INFINITY;
  }

  const forward = rotateLocalForward(slot.rotation);
  const forwardLength = Math.hypot(forward[0], forward[1], forward[2]);
  if (!Number.isFinite(forwardLength) || forwardLength === 0) {
    return Number.POSITIVE_INFINITY;
  }

  const cosine = (forward[0] * targetX + forward[2] * targetZ)
    / (forwardLength * targetLength);
  const clampedCosine = Math.max(-1, Math.min(1, cosine));
  return Math.acos(clampedCosine) * 180 / Math.PI;
}

/** AABB half extents of the registry-sized local box after slot rotation. */
export function colliderWorldHalfExtents(
  rotation: QuaternionTuple,
  dimensions: CarColliderDimensions,
): Vector3Tuple {
  const magnitude = quaternionMagnitude(rotation);
  if (!Number.isFinite(magnitude) || magnitude === 0) {
    fail('invalid-transform', 'Cannot resolve collider bounds from an invalid quaternion.');
  }

  const x = rotation[0] / magnitude;
  const y = rotation[1] / magnitude;
  const z = rotation[2] / magnitude;
  const w = rotation[3] / magnitude;

  const r00 = 1 - 2 * (y * y + z * z);
  const r01 = 2 * (x * y - z * w);
  const r02 = 2 * (x * z + y * w);
  const r10 = 2 * (x * y + z * w);
  const r11 = 1 - 2 * (x * x + z * z);
  const r12 = 2 * (y * z - x * w);
  const r20 = 2 * (x * z - y * w);
  const r21 = 2 * (y * z + x * w);
  const r22 = 1 - 2 * (x * x + y * y);

  const halfWidth = dimensions.width / 2;
  const halfHeight = dimensions.height / 2;
  const halfLength = dimensions.length / 2;

  return freezeVector3([
    Math.abs(r00) * halfWidth + Math.abs(r01) * halfHeight + Math.abs(r02) * halfLength,
    Math.abs(r10) * halfWidth + Math.abs(r11) * halfHeight + Math.abs(r12) * halfLength,
    Math.abs(r20) * halfWidth + Math.abs(r21) * halfHeight + Math.abs(r22) * halfLength,
  ]);
}

function validateSlotShape(
  candidate: unknown,
  team: Team,
  index: KickoffSlotIndex,
  seenIds: Set<string>,
): KickoffSlot {
  if (!isRecord(candidate)) {
    fail('invalid-slot', `${team} slot ${index} must be an object.`);
  }

  const expectedId = `${team}-${index}`;
  if (candidate.id !== expectedId || candidate.team !== team || candidate.index !== index) {
    fail(
      'invalid-slot',
      `${team} slot ${index} must use stable id "${expectedId}" and matching team/index fields.`,
    );
  }
  if (seenIds.has(expectedId)) {
    fail('duplicate-slot-id', `Slot id "${expectedId}" appears more than once.`);
  }
  seenIds.add(expectedId);

  const position = finiteTuple(
    candidate.position,
    3,
    `${expectedId} position`,
    'invalid-transform',
  );
  const rotation = finiteTuple(
    candidate.rotation,
    4,
    `${expectedId} rotation`,
    'invalid-transform',
  );
  const rotationMagnitude = quaternionMagnitude(rotation);
  if (Math.abs(rotationMagnitude - 1) > QUATERNION_UNIT_TOLERANCE) {
    fail('invalid-transform', `${expectedId} rotation must be a normalized quaternion.`);
  }

  return candidate as unknown as KickoffSlot;
}

function equalTuple(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length
    && left.every((component, index) => component === right[index]);
}

function validateContained(
  slot: KickoffSlot,
  bounds: KickoffArenaBounds,
  dimensions: CarColliderDimensions,
): void {
  const extents = colliderWorldHalfExtents(slot.rotation, dimensions);
  for (let axis = 0; axis < 3; axis += 1) {
    const slotMin = slot.position[axis] - extents[axis];
    const slotMax = slot.position[axis] + extents[axis];
    if (slotMin < bounds.min[axis] - CONTAINMENT_TOLERANCE_METERS
      || slotMax > bounds.max[axis] + CONTAINMENT_TOLERANCE_METERS) {
      fail('outside-arena', `${slot.id} collider lies outside the playable arena bounds.`);
    }
  }
}

/**
 * Validate an entire table before it can be used by assignment or body placement.
 * Any failure rejects the table as a whole.
 */
export function validateKickoffSlotTable(
  candidate: unknown,
  options: KickoffSlotValidationOptions,
): asserts candidate is KickoffSlotTable {
  if (!isRecord(options)) {
    fail('invalid-table', 'Kickoff validation options are required.');
  }
  validateBounds(options.arenaBounds);
  const dimensions = resolveCarColliderDimensions(
    options.tuningRegistry,
    options.colliderTuningIds ?? CAR_COLLIDER_TUNING_IDS,
  );

  if (!isRecord(candidate)) {
    fail('invalid-table', 'Kickoff slot table must be an object.');
  }
  const tableKeys = Object.keys(candidate).sort();
  if (tableKeys.length !== 2 || tableKeys[0] !== 'blue' || tableKeys[1] !== 'orange') {
    fail('invalid-table', 'Kickoff slot table must contain exactly Blue and Orange teams.');
  }
  if (!Array.isArray(candidate.blue) || !Array.isArray(candidate.orange)) {
    fail('invalid-table', 'Blue and Orange slot collections must be arrays.');
  }
  if (candidate.blue.length !== KICKOFF_SLOT_COUNT_PER_TEAM
    || candidate.orange.length !== KICKOFF_SLOT_COUNT_PER_TEAM) {
    fail(
      'invalid-team-count',
      `Each team must define exactly ${KICKOFF_SLOT_COUNT_PER_TEAM} kickoff slots.`,
    );
  }

  const seenIds = new Set<string>();
  const blueSlots: KickoffSlot[] = [];
  const orangeSlots: KickoffSlot[] = [];

  for (const index of KICKOFF_SLOT_INDEXES) {
    blueSlots.push(validateSlotShape(candidate.blue[index], 'blue', index, seenIds));
    orangeSlots.push(validateSlotShape(candidate.orange[index], 'orange', index, seenIds));
  }

  for (const slot of [...blueSlots, ...orangeSlots]) {
    const facingError = centerFacingErrorDegrees(slot, options.arenaBounds.center);
    if (!Number.isFinite(facingError)
      || facingError > TEAM_FACING_MAX_ERROR_DEGREES + Number.EPSILON) {
      fail(
        'invalid-facing',
        `${slot.id} faces ${facingError.toFixed(6)} degrees away from arena center.`,
      );
    }
    validateContained(slot, options.arenaBounds, dimensions);
  }

  for (const index of KICKOFF_SLOT_INDEXES) {
    const expectedOrange = mirrorBlueKickoffSlot(blueSlots[index], options.arenaBounds.center);
    const actualOrange = orangeSlots[index];
    if (!equalTuple(actualOrange.position, expectedOrange.position)
      || !equalTuple(actualOrange.rotation, expectedOrange.rotation)) {
      fail('invalid-mirror', `${actualOrange.id} is not the exact mirror of blue-${index}.`);
    }
  }
}

export function isValidKickoffSlotTable(
  candidate: unknown,
  options: KickoffSlotValidationOptions,
): candidate is KickoffSlotTable {
  try {
    validateKickoffSlotTable(candidate, options);
    return true;
  } catch (error) {
    if (error instanceof InvalidKickoffSlotTableError) {
      return false;
    }
    throw error;
  }
}
