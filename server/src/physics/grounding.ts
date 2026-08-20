import RAPIER from '@dimforge/rapier3d-compat';
import {
  DEFAULT_TUNING_REGISTRY_SNAPSHOT,
  TUNING_IDS,
  getScalarTuningValue,
  getVectorTuningValue,
  type ArenaSurfaceDescriptor,
  type SurfaceCapability,
  type SurfaceSemanticKind,
  type TuningRegistrySnapshot,
} from '@rocket-arena/shared';
import { getConstant } from '@rocket-arena/shared/constants';

export interface GroundingVector3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface GroundingQuaternion {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
}

export interface RegisteredArenaSurface {
  readonly colliderHandle: number;
  readonly surfaceId: string;
  readonly kind: SurfaceSemanticKind;
  readonly capability: SurfaceCapability;
  readonly groundingEnabled: boolean;
}

interface RegistryEntry {
  readonly metadata: RegisteredArenaSurface;
}

/** Advanced support stays unavailable until its later capability wave. */
export const ADVANCED_SURFACE_GROUNDING_ENABLED = false as const;

/** Collider handles are scoped to this registry's one owning Rapier world. */
export class ArenaSurfaceRegistry {
  readonly #world: RAPIER.World;
  readonly #entriesByHandle = new Map<number, RegistryEntry>();

  constructor(world: RAPIER.World) {
    this.#world = world;
  }

  belongsTo(world: RAPIER.World): boolean {
    return this.#world === world;
  }

  register(
    collider: RAPIER.Collider,
    descriptor: ArenaSurfaceDescriptor,
    groundingEnabled: boolean = descriptor.capability === 'core',
  ): RegisteredArenaSurface {
    if (!collider.isValid()) throw new TypeError('Cannot register an invalid arena collider.');
    if (this.#entriesByHandle.has(collider.handle)) {
      throw new TypeError(`Collider ${collider.handle} already has arena surface metadata.`);
    }
    const metadata = Object.freeze({
      colliderHandle: collider.handle,
      surfaceId: descriptor.id,
      kind: descriptor.kind,
      capability: descriptor.capability,
      groundingEnabled: descriptor.capability === 'core' && groundingEnabled,
    });
    this.#entriesByHandle.set(collider.handle, { metadata });
    return metadata;
  }

  /** Remove one registration without assuming the Rapier collider is still valid. */
  unregister(colliderOrHandle: RAPIER.Collider | number): RegisteredArenaSurface | null {
    const handle = typeof colliderOrHandle === 'number'
      ? colliderOrHandle
      : colliderOrHandle.handle;
    const entry = this.#entriesByHandle.get(handle);
    if (entry === undefined) return null;
    this.#entriesByHandle.delete(handle);
    return entry.metadata;
  }

  get(collider: RAPIER.Collider): RegisteredArenaSurface | null {
    if (!collider.isValid()) return null;
    return this.#entriesByHandle.get(collider.handle)?.metadata ?? null;
  }

  entries(): readonly RegisteredArenaSurface[] {
    return [...this.#entriesByHandle.values()]
      .map(({ metadata }) => metadata)
      .sort(compareRegisteredSurfaces);
  }
}

export type GroundingTuningSnapshot = Pick<TuningRegistrySnapshot, 'get'>;

export interface GroundingOptions {
  readonly tuning?: GroundingTuningSnapshot;
  /** Live staging policy: reject support normals steeper than this world-up angle. */
  readonly maximumDriveableSlopeDegrees?: number;
}

export interface GroundingHit {
  readonly surfaceId: string;
  readonly colliderHandle: number;
  readonly contactPointIndex: number;
  readonly distance: number;
  readonly point: GroundingVector3;
  readonly normal: GroundingVector3;
}

export interface SurfaceRelativeBasis {
  readonly normal: GroundingVector3;
  readonly forward: GroundingVector3;
  readonly right: GroundingVector3;
}

export interface GroundingResult {
  readonly grounded: boolean;
  readonly normal: GroundingVector3 | null;
  readonly basis: SurfaceRelativeBasis | null;
  /** Near-contact driveable surface used only for angular self-righting. */
  readonly recoveryBasis?: SurfaceRelativeBasis | null;
  readonly acceptedHits: readonly GroundingHit[];
}

const EPSILON = 1e-10;
const RECOVERY_SUPPORT_CLEARANCE = 0.05;
const WORLD_UP: GroundingVector3 = Object.freeze({ x: 0, y: 1, z: 0 });
const WORLD_FORWARD: GroundingVector3 = Object.freeze({ x: 0, y: 0, z: 1 });

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareRegisteredSurfaces(
  left: RegisteredArenaSurface,
  right: RegisteredArenaSurface,
): number {
  return compareText(left.surfaceId, right.surfaceId)
    || left.colliderHandle - right.colliderHandle;
}

function compareHits(left: GroundingHit, right: GroundingHit): number {
  return left.contactPointIndex - right.contactPointIndex
    || left.colliderHandle - right.colliderHandle
    || left.distance - right.distance
    || compareText(left.surfaceId, right.surfaceId);
}

function finiteVector(value: GroundingVector3 | undefined): GroundingVector3 | null {
  if (value === undefined || ![value.x, value.y, value.z].every(Number.isFinite)) return null;
  return { x: value.x, y: value.y, z: value.z };
}

function normalize(
  value: GroundingVector3,
  fallback: GroundingVector3 = WORLD_UP,
): GroundingVector3 {
  const length = Math.hypot(value.x, value.y, value.z);
  if (!Number.isFinite(length) || length <= EPSILON) return { ...fallback };
  return { x: value.x / length, y: value.y / length, z: value.z / length };
}

function normalizeFinite(value: GroundingVector3 | undefined): GroundingVector3 | null {
  const finite = finiteVector(value);
  if (finite === null) return null;
  const length = Math.hypot(finite.x, finite.y, finite.z);
  if (!Number.isFinite(length) || length <= EPSILON) return null;
  return { x: finite.x / length, y: finite.y / length, z: finite.z / length };
}

/**
 * Combine already-sorted support normals. Invalid candidates are ignored and a
 * degenerate sum retains the first valid normal in deterministic hit order.
 */
export function combineGroundingNormals(
  sortedNormals: readonly GroundingVector3[],
): GroundingVector3 | null {
  let firstValid: GroundingVector3 | null = null;
  let normalSum: GroundingVector3 = { x: 0, y: 0, z: 0 };
  for (const candidate of sortedNormals) {
    const normal = normalizeFinite(candidate);
    if (normal === null) continue;
    firstValid ??= normal;
    normalSum = add(normalSum, normal);
  }
  return firstValid === null ? null : normalize(normalSum, firstValid);
}

function finiteQuaternion(value: GroundingQuaternion): GroundingQuaternion {
  if (![value.x, value.y, value.z, value.w].every(Number.isFinite)) {
    return { x: 0, y: 0, z: 0, w: 1 };
  }
  const length = Math.hypot(value.x, value.y, value.z, value.w);
  if (!Number.isFinite(length) || length <= EPSILON) return { x: 0, y: 0, z: 0, w: 1 };
  return {
    x: value.x / length,
    y: value.y / length,
    z: value.z / length,
    w: value.w / length,
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

function add(left: GroundingVector3, right: GroundingVector3): GroundingVector3 {
  return { x: left.x + right.x, y: left.y + right.y, z: left.z + right.z };
}

function scale(vector: GroundingVector3, scalar: number): GroundingVector3 {
  return { x: vector.x * scalar, y: vector.y * scalar, z: vector.z * scalar };
}

function dot(left: GroundingVector3, right: GroundingVector3): number {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

function cross(left: GroundingVector3, right: GroundingVector3): GroundingVector3 {
  return {
    x: left.y * right.z - left.z * right.y,
    y: left.z * right.x - left.x * right.z,
    z: left.x * right.y - left.y * right.x,
  };
}

function subtract(left: GroundingVector3, right: GroundingVector3): GroundingVector3 {
  return { x: left.x - right.x, y: left.y - right.y, z: left.z - right.z };
}

function resolveScalar(
  tuning: GroundingTuningSnapshot,
  id: string,
  predicate: (value: number) => boolean,
): number {
  const fallback = getScalarTuningValue(DEFAULT_TUNING_REGISTRY_SNAPSHOT, id);
  try {
    const candidate = getScalarTuningValue(tuning, id);
    if (Number.isFinite(candidate) && predicate(candidate)) return candidate;
  } catch {
    // Use the immutable registry fallback for malformed snapshots.
  }
  return fallback;
}

function validContactPointVector(values: readonly number[]): boolean {
  if (values.length < 12 || values.length % 3 !== 0 || !values.every(Number.isFinite)) return false;
  const distinct = new Set<string>();
  for (let index = 0; index < values.length; index += 3) {
    distinct.add(`${values[index]},${values[index + 1]},${values[index + 2]}`);
  }
  return distinct.size >= 4;
}

function resolveContactPoints(tuning: GroundingTuningSnapshot): readonly GroundingVector3[] {
  let values: readonly number[];
  try {
    const candidate = getVectorTuningValue(tuning, TUNING_IDS.support.contactPoints);
    values = validContactPointVector(candidate)
      ? candidate
      : getVectorTuningValue(DEFAULT_TUNING_REGISTRY_SNAPSHOT, TUNING_IDS.support.contactPoints);
  } catch {
    values = getVectorTuningValue(
      DEFAULT_TUNING_REGISTRY_SNAPSHOT,
      TUNING_IDS.support.contactPoints,
    );
  }

  const points: GroundingVector3[] = [];
  for (let index = 0; index < values.length; index += 3) {
    points.push({ x: values[index]!, y: values[index + 1]!, z: values[index + 2]! });
  }
  return points;
}

/** Build a finite orthonormal command basis tangent to the accepted support. */
export function createSurfaceRelativeBasis(
  surfaceNormal: GroundingVector3,
  preferredForward: GroundingVector3,
): SurfaceRelativeBasis {
  const normal = normalize(finiteVector(surfaceNormal) ?? WORLD_UP);
  const requestedForward = normalize(finiteVector(preferredForward) ?? WORLD_FORWARD, WORLD_FORWARD);
  let tangent = subtract(requestedForward, scale(normal, dot(requestedForward, normal)));

  if (Math.hypot(tangent.x, tangent.y, tangent.z) <= EPSILON) {
    const candidates: readonly GroundingVector3[] = [
      { x: 1, y: 0, z: 0 },
      { x: 0, y: 0, z: 1 },
      { x: 0, y: 1, z: 0 },
    ];
    const fallback = [...candidates].sort(
      (left, right) => Math.abs(dot(left, normal)) - Math.abs(dot(right, normal)),
    )[0]!;
    tangent = subtract(fallback, scale(normal, dot(fallback, normal)));
  }

  const forward = normalize(tangent, WORLD_FORWARD);
  const right = normalize(cross(normal, forward), { x: 1, y: 0, z: 0 });
  return { normal, forward: normalize(cross(right, normal), forward), right };
}

/** Convert normalized forward/right intent into finite surface-relative geometry. */
export function projectSurfaceCommand(
  basis: SurfaceRelativeBasis,
  forwardAmount: number,
  rightAmount: number,
): GroundingVector3 {
  const forward = Number.isFinite(forwardAmount) ? Math.max(-1, Math.min(1, forwardAmount)) : 0;
  const right = Number.isFinite(rightAmount) ? Math.max(-1, Math.min(1, rightAmount)) : 0;
  const command = add(scale(basis.forward, forward), scale(basis.right, right));
  const magnitude = Math.hypot(command.x, command.y, command.z);
  return magnitude > 1 ? scale(command, 1 / magnitude) : command;
}

/** Cast every registry support point along the car's rotated Local_Down axis. */
export function detectGroundSupport(
  world: RAPIER.World,
  body: RAPIER.RigidBody,
  surfaces: ArenaSurfaceRegistry,
  options: Readonly<GroundingOptions> = {},
): GroundingResult {
  if (!surfaces.belongsTo(world)) {
    throw new TypeError('Arena surface registry belongs to a different Rapier world.');
  }
  const tuning = options.tuning ?? DEFAULT_TUNING_REGISTRY_SNAPSHOT;
  const contactPoints = resolveContactPoints(tuning);
  const rayDistance = resolveScalar(
    tuning,
    TUNING_IDS.support.rayDistance,
    (value) => value > 0,
  );
  const thresholdDegrees = resolveScalar(
    tuning,
    TUNING_IDS.support.normalAngleThresholdDegrees,
    (value) => value >= 0 && value <= 90,
  );
  const minimumNormalDot = Math.cos(thresholdDegrees * Math.PI / 180);
  const maximumDriveableSlopeDegrees = Number.isFinite(options.maximumDriveableSlopeDegrees)
    ? Math.max(0, Math.min(90, options.maximumDriveableSlopeDegrees as number))
    : 90;
  const minimumWorldUpDot = maximumDriveableSlopeDegrees >= 90
    ? -1
    : Math.cos(maximumDriveableSlopeDegrees * Math.PI / 180);
  const rotation = finiteQuaternion(body.rotation());
  const translation = finiteVector(body.translation()) ?? { x: 0, y: 0, z: 0 };
  const localDown = normalize(rotateVector(rotation, { x: 0, y: -1, z: 0 }), { x: 0, y: -1, z: 0 });
  const localRoof = scale(localDown, -1);
  const localForward = normalize(rotateVector(rotation, WORLD_FORWARD), WORLD_FORWARD);
  const acceptedHits: GroundingHit[] = [];
  const filterFlags = RAPIER.QueryFilterFlags.ONLY_FIXED | RAPIER.QueryFilterFlags.EXCLUDE_SENSORS;

  for (let contactPointIndex = 0; contactPointIndex < contactPoints.length; contactPointIndex += 1) {
    const localPoint = contactPoints[contactPointIndex]!;
    const origin = add(translation, rotateVector(rotation, localPoint));
    const ray = new RAPIER.Ray(origin, localDown);
    const hit = world.castRayAndGetNormal(
      ray,
      rayDistance,
      true,
      filterFlags,
      undefined,
      undefined,
      body,
      (collider) => {
        const surface = surfaces.get(collider);
        return collider.isValid()
          && collider.isEnabled()
          && !collider.isSensor()
          && surface?.capability === 'core'
          && surface.groundingEnabled;
      },
    );
    if (hit === null || !Number.isFinite(hit.timeOfImpact)) continue;
    if (hit.timeOfImpact < 0 || hit.timeOfImpact > rayDistance + EPSILON) continue;
    const normal = normalizeFinite(hit.normal);
    if (normal === null) continue;
    if (dot(normal, WORLD_UP) + EPSILON < minimumWorldUpDot) continue;
    if (dot(normal, localRoof) + EPSILON < minimumNormalDot) continue;
    const surface = surfaces.get(hit.collider);
    if (surface === null) continue;
    acceptedHits.push({
      surfaceId: surface.surfaceId,
      colliderHandle: hit.collider.handle,
      contactPointIndex,
      distance: hit.timeOfImpact,
      point: ray.pointAt(hit.timeOfImpact),
      normal,
    });
  }

  const primarySupportDetected = acceptedHits.length > 0;

  // A chassis resting on its side cannot cast useful Local_Down wheel rays.
  // Use one tightly bounded world-down center probe whose length is the rounded
  // body's projected support extent plus 5 cm. This recovers near-contact floor
  // and ramp support without reaching genuinely airborne cars or vertical walls.
  if (acceptedHits.length === 0) {
    const halfWidth = resolveScalar(
      tuning,
      TUNING_IDS.car.collider.width,
      (value) => value > 0,
    ) / 2;
    const halfHeight = resolveScalar(
      tuning,
      TUNING_IDS.car.collider.height,
      (value) => value > 0,
    ) / 2;
    const halfLength = resolveScalar(
      tuning,
      TUNING_IDS.car.collider.length,
      (value) => value > 0,
    ) / 2;
    const cornerRadius = Math.min(
      getConstant('CAR.BODY.CORNER_RADIUS'),
      halfWidth - Number.EPSILON,
      halfHeight - Number.EPSILON,
      halfLength - Number.EPSILON,
    );
    const localRight = rotateVector(rotation, { x: 1, y: 0, z: 0 });
    const projectedHalfExtent = Math.abs(localRight.y) * (halfWidth - cornerRadius)
      + Math.abs(localRoof.y) * (halfHeight - cornerRadius)
      + Math.abs(localForward.y) * (halfLength - cornerRadius)
      + cornerRadius;
    const recoveryRayDistance = projectedHalfExtent + RECOVERY_SUPPORT_CLEARANCE;
    const recoveryRay = new RAPIER.Ray(translation, { x: 0, y: -1, z: 0 });
    const recoveryHit = world.castRayAndGetNormal(
      recoveryRay,
      recoveryRayDistance,
      true,
      filterFlags,
      undefined,
      undefined,
      body,
      (collider) => {
        const surface = surfaces.get(collider);
        return collider.isValid()
          && collider.isEnabled()
          && !collider.isSensor()
          && surface?.capability === 'core'
          && surface.groundingEnabled;
      },
    );
    if (
      recoveryHit !== null
      && Number.isFinite(recoveryHit.timeOfImpact)
      && recoveryHit.timeOfImpact >= 0
      && recoveryHit.timeOfImpact <= recoveryRayDistance + EPSILON
    ) {
      const normal = normalizeFinite(recoveryHit.normal);
      const surface = surfaces.get(recoveryHit.collider);
      if (
        normal !== null
        && surface !== null
        && dot(normal, WORLD_UP) + EPSILON >= minimumWorldUpDot
      ) {
        acceptedHits.push({
          surfaceId: surface.surfaceId,
          colliderHandle: recoveryHit.collider.handle,
          contactPointIndex: contactPoints.length,
          distance: recoveryHit.timeOfImpact,
          point: recoveryRay.pointAt(recoveryHit.timeOfImpact),
          normal,
        });
      }
    }
  }

  acceptedHits.sort(compareHits);
  if (acceptedHits.length === 0) {
    return {
      grounded: false,
      normal: null,
      basis: null,
      acceptedHits: [],
    };
  }

  const normal = combineGroundingNormals(acceptedHits.map((hit) => hit.normal));
  if (normal === null) {
    return {
      grounded: false,
      normal: null,
      basis: null,
      acceptedHits: [],
    };
  }
  const resolvedBasis = createSurfaceRelativeBasis(normal, localForward);
  return primarySupportDetected
    ? {
      grounded: true,
      normal,
      basis: resolvedBasis,
      acceptedHits,
    }
    : {
      grounded: false,
      normal: null,
      basis: null,
      recoveryBasis: resolvedBasis,
      acceptedHits,
    };
}
