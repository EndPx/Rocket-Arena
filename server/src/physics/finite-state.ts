import type RAPIER from '@dimforge/rapier3d-compat';

export interface FiniteVector3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface FiniteQuaternion extends FiniteVector3 {
  readonly w: number;
}

export interface FiniteRigidBodyState {
  readonly translation: FiniteVector3;
  readonly rotation: FiniteQuaternion;
  readonly linearVelocity: FiniteVector3;
  readonly angularVelocity: FiniteVector3;
}

export interface FiniteRigidBodyFallback {
  readonly translation?: FiniteVector3;
  readonly rotation?: FiniteQuaternion;
  readonly linearVelocity?: FiniteVector3;
  readonly angularVelocity?: FiniteVector3;
}

export interface FiniteRigidBodyStateTracker {
  readonly fallback: FiniteRigidBodyState;
  lastFinite: FiniteRigidBodyState;
}

const ZERO_VECTOR: FiniteVector3 = Object.freeze({ x: 0, y: 0, z: 0 });
const IDENTITY_ROTATION: FiniteQuaternion = Object.freeze({ x: 0, y: 0, z: 0, w: 1 });
const NORMALIZATION_TOLERANCE = 1e-6;

function freezeVector(vector: FiniteVector3): FiniteVector3 {
  return Object.freeze({ x: vector.x, y: vector.y, z: vector.z });
}

function freezeQuaternion(rotation: FiniteQuaternion): FiniteQuaternion {
  return Object.freeze({
    x: rotation.x,
    y: rotation.y,
    z: rotation.z,
    w: rotation.w,
  });
}

function freezeState(state: FiniteRigidBodyState): FiniteRigidBodyState {
  return Object.freeze({
    translation: freezeVector(state.translation),
    rotation: freezeQuaternion(state.rotation),
    linearVelocity: freezeVector(state.linearVelocity),
    angularVelocity: freezeVector(state.angularVelocity),
  });
}

function isFiniteVector(vector: FiniteVector3): boolean {
  return Number.isFinite(vector.x)
    && Number.isFinite(vector.y)
    && Number.isFinite(vector.z);
}

function maxAbs(values: readonly number[]): number {
  let maximum = 0;
  for (const value of values) maximum = Math.max(maximum, Math.abs(value));
  return maximum;
}

function normalizedQuaternion(rotation: FiniteQuaternion): FiniteQuaternion | null {
  if (
    !Number.isFinite(rotation.x)
    || !Number.isFinite(rotation.y)
    || !Number.isFinite(rotation.z)
    || !Number.isFinite(rotation.w)
  ) return null;

  const scale = maxAbs([rotation.x, rotation.y, rotation.z, rotation.w]);
  if (scale <= Number.EPSILON) return null;
  const x = rotation.x / scale;
  const y = rotation.y / scale;
  const z = rotation.z / scale;
  const w = rotation.w / scale;
  const length = Math.hypot(x, y, z, w);
  if (!Number.isFinite(length) || length <= Number.EPSILON) return null;

  return {
    x: x / length,
    y: y / length,
    z: z / length,
    w: w / length,
  };
}

function vectorsEqual(left: FiniteVector3, right: FiniteVector3): boolean {
  return left.x === right.x && left.y === right.y && left.z === right.z;
}

function quaternionsNearlyEqual(left: FiniteQuaternion, right: FiniteQuaternion): boolean {
  return Math.abs(left.x - right.x) <= NORMALIZATION_TOLERANCE
    && Math.abs(left.y - right.y) <= NORMALIZATION_TOLERANCE
    && Math.abs(left.z - right.z) <= NORMALIZATION_TOLERANCE
    && Math.abs(left.w - right.w) <= NORMALIZATION_TOLERANCE;
}

/** Copy one finite vector, otherwise copy the supplied finite fallback. */
export function finiteVectorOrFallback(
  candidate: FiniteVector3,
  fallback: FiniteVector3 = ZERO_VECTOR,
): FiniteVector3 {
  const safeFallback = isFiniteVector(fallback) ? fallback : ZERO_VECTOR;
  return freezeVector(isFiniteVector(candidate) ? candidate : safeFallback);
}

/** Normalize one finite non-zero quaternion, otherwise use a normalized fallback. */
export function finiteQuaternionOrFallback(
  candidate: FiniteQuaternion,
  fallback: FiniteQuaternion = IDENTITY_ROTATION,
): FiniteQuaternion {
  return freezeQuaternion(
    normalizedQuaternion(candidate)
      ?? normalizedQuaternion(fallback)
      ?? IDENTITY_ROTATION,
  );
}

function resolveState(
  body: RAPIER.RigidBody,
  previous: FiniteRigidBodyState,
): {
  readonly state: FiniteRigidBodyState;
  readonly repairTranslation: boolean;
  readonly repairRotation: boolean;
  readonly repairLinearVelocity: boolean;
  readonly repairAngularVelocity: boolean;
} {
  const observedTranslation = body.translation();
  const observedRotation = body.rotation();
  const observedLinearVelocity = body.linvel();
  const observedAngularVelocity = body.angvel();

  const translation = finiteVectorOrFallback(observedTranslation, previous.translation);
  const rotation = finiteQuaternionOrFallback(observedRotation, previous.rotation);
  const linearVelocity = finiteVectorOrFallback(
    observedLinearVelocity,
    previous.linearVelocity,
  );
  const angularVelocity = finiteVectorOrFallback(
    observedAngularVelocity,
    previous.angularVelocity,
  );

  return {
    state: freezeState({ translation, rotation, linearVelocity, angularVelocity }),
    repairTranslation: !isFiniteVector(observedTranslation),
    repairRotation: normalizedQuaternion(observedRotation) === null
      || !quaternionsNearlyEqual(observedRotation, rotation),
    repairLinearVelocity: !isFiniteVector(observedLinearVelocity),
    repairAngularVelocity: !isFiniteVector(observedAngularVelocity),
  };
}

/**
 * Start tracking a body from a defined finite fallback. Each transform and
 * motion vector is independent so one invalid observation never overwrites
 * another valid field.
 */
export function createFiniteRigidBodyStateTracker(
  body: RAPIER.RigidBody,
  fallback: FiniteRigidBodyFallback = {},
): FiniteRigidBodyStateTracker {
  const safeFallback = freezeState({
    translation: finiteVectorOrFallback(fallback.translation ?? ZERO_VECTOR),
    rotation: finiteQuaternionOrFallback(fallback.rotation ?? IDENTITY_ROTATION),
    linearVelocity: finiteVectorOrFallback(fallback.linearVelocity ?? ZERO_VECTOR),
    angularVelocity: finiteVectorOrFallback(fallback.angularVelocity ?? ZERO_VECTOR),
  });
  const tracker: FiniteRigidBodyStateTracker = {
    fallback: safeFallback,
    lastFinite: safeFallback,
  };
  recoverFiniteRigidBodyState(body, tracker);
  return tracker;
}

/** Repair non-finite body fields from their own last-finite value or fallback. */
export function recoverFiniteRigidBodyState(
  body: RAPIER.RigidBody,
  tracker: FiniteRigidBodyStateTracker,
): FiniteRigidBodyState {
  const previous = tracker.lastFinite ?? tracker.fallback;
  const resolved = resolveState(body, previous);

  if (resolved.repairTranslation) body.setTranslation(resolved.state.translation, true);
  if (resolved.repairRotation) body.setRotation(resolved.state.rotation, true);
  if (resolved.repairLinearVelocity) {
    body.setLinvel(resolved.state.linearVelocity, true);
  }
  if (resolved.repairAngularVelocity) {
    body.setAngvel(resolved.state.angularVelocity, true);
  }

  tracker.lastFinite = resolved.state;
  return resolved.state;
}

function boundedVector(vector: FiniteVector3, maximumMagnitude: number): FiniteVector3 {
  if (!Number.isFinite(maximumMagnitude) || maximumMagnitude < 0) {
    throw new RangeError('A rigid-body motion bound must be finite and non-negative.');
  }

  const scale = maxAbs([vector.x, vector.y, vector.z]);
  if (scale <= Number.EPSILON) return freezeVector(ZERO_VECTOR);
  const x = vector.x / scale;
  const y = vector.y / scale;
  const z = vector.z / scale;
  const normalizedLength = Math.hypot(x, y, z);
  const magnitude = scale * normalizedLength;
  if (magnitude <= maximumMagnitude) return freezeVector(vector);

  const boundedScale = maximumMagnitude / normalizedLength;
  return freezeVector({
    x: x * boundedScale,
    y: y * boundedScale,
    z: z * boundedScale,
  });
}

/**
 * Repair first, then cap linear and angular velocity without changing either
 * vector's Rapier-produced direction. The stored last-finite state is always
 * the bounded state that may safely be restored on a later step.
 */
export function recoverAndBoundRigidBodyMotion(
  body: RAPIER.RigidBody,
  tracker: FiniteRigidBodyStateTracker,
  maximumLinearSpeed: number,
  maximumAngularSpeed: number,
): FiniteRigidBodyState {
  const recovered = recoverFiniteRigidBodyState(body, tracker);
  const linearVelocity = boundedVector(recovered.linearVelocity, maximumLinearSpeed);
  const angularVelocity = boundedVector(recovered.angularVelocity, maximumAngularSpeed);

  if (!vectorsEqual(linearVelocity, recovered.linearVelocity)) {
    body.setLinvel(linearVelocity, true);
  }
  if (!vectorsEqual(angularVelocity, recovered.angularVelocity)) {
    body.setAngvel(angularVelocity, true);
  }

  const bounded = freezeState({
    translation: recovered.translation,
    rotation: recovered.rotation,
    linearVelocity,
    angularVelocity,
  });
  tracker.lastFinite = bounded;
  return bounded;
}
