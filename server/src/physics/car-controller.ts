import {
  DEFAULT_TUNING_REGISTRY_SNAPSHOT,
  TUNING_IDS,
  getCurveTuningValue,
  getScalarTuningValue,
  type InputCommandV2,
  type StructuredCurve,
  type TuningRegistrySnapshot,
} from '@rocket-arena/shared';

export interface ControllerVector3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface ControllerQuaternion {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
}

export interface ControllerSurfaceBasis {
  readonly normal: ControllerVector3;
  readonly forward: ControllerVector3;
  readonly right: ControllerVector3;
}

export interface CarControllerObservation {
  readonly rotation: ControllerQuaternion;
  readonly linearVelocity: ControllerVector3;
  readonly angularVelocity?: ControllerVector3;
  readonly grounded: boolean;
  readonly surfaceBasis?: ControllerSurfaceBasis | null;
}

export interface CarControllerFiniteState {
  readonly rotation: ControllerQuaternion;
  readonly linearVelocity: ControllerVector3;
  readonly angularVelocity?: ControllerVector3;
}

export type CarControllerTuningSnapshot = Pick<TuningRegistrySnapshot, 'get'>;

export interface CarControllerPlanningContext {
  readonly observation: CarControllerObservation;
  /** Authoritative inventory supplied by the caller. This planner never mutates it. */
  readonly availableBoost: number;
  readonly previousFiniteState?: CarControllerFiniteState;
  readonly tuning?: CarControllerTuningSnapshot;
  readonly timestepSeconds?: number;
  readonly dragEnabled?: boolean;
}

export interface GroundedControlPlan {
  readonly basis: ControllerSurfaceBasis;
  readonly surfaceForwardSpeed: number;
  readonly surfaceLateralSpeed: number;
  readonly powerslideActive: boolean;
  readonly gripRate: number;
  readonly gripAlpha: number;
  readonly baseCurvature: number;
  readonly commandedCurvature: number;
  readonly currentYawRate: number;
  readonly targetYawRate: number;
}

export interface CarControllerPlan {
  readonly localForward: ControllerVector3;
  readonly forwardSpeed: number;
  readonly normalizedThrottle: number;
  readonly normalizedSteer: number;
  readonly throttleAcceleration: ControllerVector3;
  /** Requested acceleration. It remains exact even when the speed cap limits its delta. */
  readonly boostAcceleration: ControllerVector3;
  readonly dragAcceleration: ControllerVector3;
  readonly requestedPropulsionAcceleration: ControllerVector3;
  readonly requestedPropulsionDeltaVelocity: ControllerVector3;
  readonly appliedPropulsionDeltaVelocity: ControllerVector3;
  readonly dragDeltaVelocity: ControllerVector3;
  readonly lateralGripDeltaVelocity: ControllerVector3;
  readonly deltaVelocity: ControllerVector3;
  readonly angularDeltaVelocity: ControllerVector3;
  readonly propulsionProjectedVelocity: ControllerVector3;
  readonly projectedVelocity: ControllerVector3;
  readonly projectedAngularVelocity: ControllerVector3;
  readonly propulsionProjectedForwardSpeed: number;
  readonly boostActuated: boolean;
  readonly groundedControl: GroundedControlPlan | null;
  readonly nextFiniteState: CarControllerFiniteState;
}

const ZERO_VECTOR: ControllerVector3 = Object.freeze({ x: 0, y: 0, z: 0 });
const IDENTITY_ROTATION: ControllerQuaternion = Object.freeze({ x: 0, y: 0, z: 0, w: 1 });
const CURVE_EPSILON = 1e-12;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function finiteVector(value: ControllerVector3 | undefined): ControllerVector3 | null {
  if (value === undefined) return null;
  if (![value.x, value.y, value.z].every(Number.isFinite)) return null;
  return { x: value.x, y: value.y, z: value.z };
}

function finiteQuaternion(value: ControllerQuaternion | undefined): ControllerQuaternion | null {
  if (value === undefined) return null;
  if (![value.x, value.y, value.z, value.w].every(Number.isFinite)) return null;
  const length = Math.hypot(value.x, value.y, value.z, value.w);
  if (!Number.isFinite(length) || length <= CURVE_EPSILON) return null;
  return {
    x: value.x / length,
    y: value.y / length,
    z: value.z / length,
    w: value.w / length,
  };
}

function scale(vector: ControllerVector3, scalar: number): ControllerVector3 {
  return { x: vector.x * scalar, y: vector.y * scalar, z: vector.z * scalar };
}

function add(left: ControllerVector3, right: ControllerVector3): ControllerVector3 {
  return { x: left.x + right.x, y: left.y + right.y, z: left.z + right.z };
}

function dot(left: ControllerVector3, right: ControllerVector3): number {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

function subtract(left: ControllerVector3, right: ControllerVector3): ControllerVector3 {
  return { x: left.x - right.x, y: left.y - right.y, z: left.z - right.z };
}

function cross(left: ControllerVector3, right: ControllerVector3): ControllerVector3 {
  return {
    x: left.y * right.z - left.z * right.y,
    y: left.z * right.x - left.x * right.z,
    z: left.x * right.y - left.y * right.x,
  };
}

function normalizeVector(value: ControllerVector3): ControllerVector3 | null {
  const length = Math.hypot(value.x, value.y, value.z);
  if (!Number.isFinite(length) || length <= CURVE_EPSILON) return null;
  return { x: value.x / length, y: value.y / length, z: value.z / length };
}

function resolveSurfaceBasis(
  candidate: ControllerSurfaceBasis | null | undefined,
  localForward: ControllerVector3,
): ControllerSurfaceBasis | null {
  const rawNormal = finiteVector(candidate?.normal);
  const rawForward = finiteVector(candidate?.forward);
  const rawRight = finiteVector(candidate?.right);
  if (rawNormal === null || rawForward === null || rawRight === null) return null;

  const normal = normalizeVector(rawNormal);
  if (normal === null) return null;
  const headingTangent = subtract(localForward, scale(normal, dot(localForward, normal)));
  const expectedForward = normalizeVector(headingTangent);
  const suppliedForward = normalizeVector(
    subtract(rawForward, scale(normal, dot(rawForward, normal))),
  );
  if (expectedForward === null || suppliedForward === null) return null;
  const expectedRight = normalizeVector(cross(normal, expectedForward));
  const suppliedRight = normalizeVector(rawRight);
  if (expectedRight === null || suppliedRight === null) return null;
  if (dot(expectedForward, suppliedForward) < 1 - 1e-6) return null;
  if (dot(expectedRight, suppliedRight) < 1 - 1e-6) return null;
  return { normal, forward: expectedForward, right: expectedRight };
}

function rotateVector(
  rotation: ControllerQuaternion,
  vector: ControllerVector3,
): ControllerVector3 {
  const tx = 2 * (rotation.y * vector.z - rotation.z * vector.y);
  const ty = 2 * (rotation.z * vector.x - rotation.x * vector.z);
  const tz = 2 * (rotation.x * vector.y - rotation.y * vector.x);
  return {
    x: vector.x + rotation.w * tx + (rotation.y * tz - rotation.z * ty),
    y: vector.y + rotation.w * ty + (rotation.z * tx - rotation.x * tz),
    z: vector.z + rotation.w * tz + (rotation.x * ty - rotation.y * tx),
  };
}

function isNonIncreasingCurve(curve: StructuredCurve): boolean {
  if (curve.outputOrder !== 'non-increasing' || curve.samples.length === 0) return false;
  let previousInput = Number.NEGATIVE_INFINITY;
  let previousOutput = Number.POSITIVE_INFINITY;
  for (const sample of curve.samples) {
    if (!Number.isFinite(sample.input) || !Number.isFinite(sample.output)) return false;
    if (sample.input <= previousInput || sample.output > previousOutput + CURVE_EPSILON) return false;
    if (sample.output < 0) return false;
    previousInput = sample.input;
    previousOutput = sample.output;
  }
  return true;
}

function isThrottleCurveForTarget(curve: StructuredCurve, targetSpeed: number): boolean {
  if (!isNonIncreasingCurve(curve) || curve.samples.length < 2) return false;
  const lastIndex = curve.samples.length - 1;
  const last = curve.samples[lastIndex]!;
  if (Math.abs(last.input - targetSpeed) > CURVE_EPSILON || Math.abs(last.output) > CURVE_EPSILON) {
    return false;
  }
  return curve.samples.slice(0, lastIndex).every(
    (sample) => sample.input < targetSpeed && sample.output > 0,
  );
}

function defaultThrottleCurve(): StructuredCurve {
  return getCurveTuningValue(
    DEFAULT_TUNING_REGISTRY_SNAPSHOT,
    TUNING_IDS.car.throttle.accelerationCurve,
  );
}

function resolveThrottleCurve(
  tuning: CarControllerTuningSnapshot,
  targetSpeed: number,
): StructuredCurve {
  try {
    const candidate = getCurveTuningValue(tuning, TUNING_IDS.car.throttle.accelerationCurve);
    if (isThrottleCurveForTarget(candidate, targetSpeed)) return candidate;
  } catch {
    // A malformed room snapshot cannot inject non-finite controller output.
  }
  return defaultThrottleCurve();
}

function resolveScalar(
  tuning: CarControllerTuningSnapshot,
  id: string,
  predicate: (value: number) => boolean,
): number {
  const fallback = getScalarTuningValue(DEFAULT_TUNING_REGISTRY_SNAPSHOT, id);
  try {
    const candidate = getScalarTuningValue(tuning, id);
    if (Number.isFinite(candidate) && predicate(candidate)) return candidate;
  } catch {
    // Fall through to the immutable default registry value.
  }
  return fallback;
}

interface SteeringTuning {
  readonly curvatureCurve: StructuredCurve;
  readonly normalGripRate: number;
  readonly powerslideGripRate: number;
  readonly powerslideCurvatureMultiplier: number;
}

function isSteeringCurveForDomain(curve: StructuredCurve, maximumSpeed: number): boolean {
  if (!isNonIncreasingCurve(curve) || curve.samples.length < 2) return false;
  const first = curve.samples[0]!;
  const last = curve.samples[curve.samples.length - 1]!;
  return first.input <= CURVE_EPSILON
    && last.input >= maximumSpeed - CURVE_EPSILON
    && curve.samples.every((sample) => sample.output > 0 && sample.output <= 0.5);
}

function resolveSteeringTuning(
  tuning: CarControllerTuningSnapshot,
  maximumSpeed: number,
): SteeringTuning {
  const fallback: SteeringTuning = {
    curvatureCurve: getCurveTuningValue(
      DEFAULT_TUNING_REGISTRY_SNAPSHOT,
      TUNING_IDS.car.steering.curvatureCurve,
    ),
    normalGripRate: getScalarTuningValue(
      DEFAULT_TUNING_REGISTRY_SNAPSHOT,
      TUNING_IDS.car.steering.normalGripRate,
    ),
    powerslideGripRate: getScalarTuningValue(
      DEFAULT_TUNING_REGISTRY_SNAPSHOT,
      TUNING_IDS.car.steering.powerslideGripRate,
    ),
    powerslideCurvatureMultiplier: getScalarTuningValue(
      DEFAULT_TUNING_REGISTRY_SNAPSHOT,
      TUNING_IDS.car.steering.powerslideCurvatureMultiplier,
    ),
  };

  try {
    const candidate: SteeringTuning = {
      curvatureCurve: getCurveTuningValue(tuning, TUNING_IDS.car.steering.curvatureCurve),
      normalGripRate: getScalarTuningValue(tuning, TUNING_IDS.car.steering.normalGripRate),
      powerslideGripRate: getScalarTuningValue(
        tuning,
        TUNING_IDS.car.steering.powerslideGripRate,
      ),
      powerslideCurvatureMultiplier: getScalarTuningValue(
        tuning,
        TUNING_IDS.car.steering.powerslideCurvatureMultiplier,
      ),
    };
    if (
      isSteeringCurveForDomain(candidate.curvatureCurve, maximumSpeed)
      && Number.isFinite(candidate.normalGripRate)
      && Number.isFinite(candidate.powerslideGripRate)
      && Number.isFinite(candidate.powerslideCurvatureMultiplier)
      && candidate.normalGripRate > candidate.powerslideGripRate
      && candidate.powerslideGripRate > 0
      && candidate.powerslideCurvatureMultiplier > 1
    ) {
      return candidate;
    }
  } catch {
    // Fall through to the validated immutable tuning group.
  }
  return fallback;
}

/** Evaluate a validated, ordered curve with clamped piecewise-linear interpolation. */
export function evaluateNonIncreasingThrottleCurve(
  curve: StructuredCurve,
  speed: number,
): number {
  if (!isNonIncreasingCurve(curve)) {
    throw new TypeError('Throttle curve must contain finite, ordered, non-increasing samples.');
  }
  const samples = curve.samples;
  const safeSpeed = Number.isFinite(speed) ? speed : samples[0]!.input;
  if (safeSpeed <= samples[0]!.input) return samples[0]!.output;

  for (let index = 1; index < samples.length; index += 1) {
    const right = samples[index]!;
    if (safeSpeed > right.input) continue;
    const left = samples[index - 1]!;
    const ratio = (safeSpeed - left.input) / (right.input - left.input);
    return left.output + (right.output - left.output) * ratio;
  }
  return samples[samples.length - 1]!.output;
}

/** Evaluate finite speed against a validated steering-curvature curve. */
export function evaluateSteeringCurvatureCurve(
  curve: StructuredCurve,
  speed: number,
): number {
  if (
    !isNonIncreasingCurve(curve)
    || curve.samples.some((sample) => sample.output <= 0 || sample.output > 0.5)
  ) {
    throw new TypeError('Steering curve must contain finite ordered samples in (0, 0.5].');
  }
  return evaluateNonIncreasingThrottleCurve(curve, Math.abs(Number.isFinite(speed) ? speed : 0));
}

function limitPropulsionProjection(
  currentProjection: number,
  requestedDelta: number,
  maximumProjection: number,
): number {
  if (currentProjection > maximumProjection) {
    if (requestedDelta >= 0) return 0;
    return Math.max(requestedDelta, -maximumProjection - currentProjection);
  }
  if (currentProjection < -maximumProjection) {
    if (requestedDelta <= 0) return 0;
    return Math.min(requestedDelta, maximumProjection - currentProjection);
  }
  return clamp(
    currentProjection + requestedDelta,
    -maximumProjection,
    maximumProjection,
  ) - currentProjection;
}

/**
 * Produce one finite propulsion/drag command without touching Rapier, inventory,
 * jump state, room state, or process-global overrides.
 */
export function planCarControllerCommand(
  input: Readonly<InputCommandV2>,
  context: Readonly<CarControllerPlanningContext>,
): CarControllerPlan {
  const tuning = context.tuning ?? DEFAULT_TUNING_REGISTRY_SNAPSHOT;
  const previousRotation = finiteQuaternion(context.previousFiniteState?.rotation);
  const previousVelocity = finiteVector(context.previousFiniteState?.linearVelocity);
  const previousAngularVelocity = finiteVector(context.previousFiniteState?.angularVelocity);
  const rotation = finiteQuaternion(context.observation.rotation)
    ?? previousRotation
    ?? IDENTITY_ROTATION;
  const linearVelocity = finiteVector(context.observation.linearVelocity)
    ?? previousVelocity
    ?? ZERO_VECTOR;
  const angularVelocity = finiteVector(context.observation.angularVelocity)
    ?? previousAngularVelocity
    ?? ZERO_VECTOR;
  const localForward = rotateVector(rotation, { x: 0, y: 0, z: 1 });
  const surfaceBasis = context.observation.grounded === true
    ? resolveSurfaceBasis(context.observation.surfaceBasis, localForward)
    : null;
  const forwardSpeed = dot(linearVelocity, localForward);
  const normalizedThrottle = Number.isFinite(input.throttle)
    ? clamp(input.throttle, -1, 1)
    : 0;
  const normalizedSteer = Number.isFinite(input.steer)
    ? clamp(input.steer, -1, 1)
    : 0;
  const timestepSeconds = Number.isFinite(context.timestepSeconds)
    && (context.timestepSeconds as number) > 0
    ? context.timestepSeconds as number
    : resolveScalar(tuning, TUNING_IDS.physics.fixedStepSeconds, (value) => value > 0);
  const targetSpeed = resolveScalar(
    tuning,
    TUNING_IDS.car.throttle.targetSpeed,
    (value) => value > 0,
  );
  const maximumPropulsionProjection = resolveScalar(
    tuning,
    TUNING_IDS.car.maxLinearSpeed,
    (value) => value > 0,
  );
  const maximumAngularSpeed = resolveScalar(
    tuning,
    TUNING_IDS.car.maxAngularSpeed,
    (value) => value > 0,
  );
  const steeringTuning = resolveSteeringTuning(tuning, maximumPropulsionProjection);
  const throttleCurve = resolveThrottleCurve(tuning, targetSpeed);

  let throttleAccelerationScalar = 0;
  if (context.observation.grounded === true && normalizedThrottle !== 0) {
    const inputDirection = Math.sign(normalizedThrottle);
    const directedSpeed = inputDirection > 0
      ? Math.max(0, forwardSpeed)
      : Math.max(0, -forwardSpeed);
    if (directedSpeed < targetSpeed) {
      throttleAccelerationScalar = inputDirection
        * Math.abs(normalizedThrottle)
        * evaluateNonIncreasingThrottleCurve(throttleCurve, directedSpeed);
    }
  }
  const throttleAcceleration = scale(localForward, throttleAccelerationScalar);

  const availableBoost = Number.isFinite(context.availableBoost)
    ? Math.max(0, context.availableBoost)
    : 0;
  const boostActuated = input.boostHeld === true && availableBoost > 0;
  const boostAccelerationMagnitude = resolveScalar(
    tuning,
    TUNING_IDS.car.boost.acceleration,
    (value) => value > 0,
  );
  const boostAcceleration = boostActuated
    ? scale(localForward, boostAccelerationMagnitude)
    : ZERO_VECTOR;
  const requestedPropulsionAcceleration = add(throttleAcceleration, boostAcceleration);
  const requestedPropulsionDeltaVelocity = scale(
    requestedPropulsionAcceleration,
    timestepSeconds,
  );
  const requestedProjectionDelta = dot(requestedPropulsionDeltaVelocity, localForward);
  const appliedProjectionDelta = limitPropulsionProjection(
    forwardSpeed,
    requestedProjectionDelta,
    maximumPropulsionProjection,
  );
  const appliedPropulsionDeltaVelocity = scale(localForward, appliedProjectionDelta);
  const propulsionProjectedVelocity = add(linearVelocity, appliedPropulsionDeltaVelocity);
  const propulsionProjectedForwardSpeed = dot(propulsionProjectedVelocity, localForward);

  const dragCoefficient = context.dragEnabled === false
    ? 0
    : resolveScalar(
      tuning,
      TUNING_IDS.car.aerodynamicDragCoefficient,
      (value) => value >= 0,
    );
  const dragFraction = Math.min(dragCoefficient * timestepSeconds, 1);
  const dragDeltaVelocity = scale(linearVelocity, -dragFraction);
  const dragAcceleration = scale(dragDeltaVelocity, 1 / timestepSeconds);

  let lateralGripDeltaVelocity: ControllerVector3 = ZERO_VECTOR;
  let angularDeltaVelocity: ControllerVector3 = ZERO_VECTOR;
  let groundedControl: GroundedControlPlan | null = null;
  if (surfaceBasis !== null) {
    const surfaceForwardSpeed = dot(linearVelocity, surfaceBasis.forward);
    const surfaceLateralSpeed = dot(linearVelocity, surfaceBasis.right);
    const powerslideActive = input.powerslideHeld === true;
    const gripRate = powerslideActive
      ? steeringTuning.powerslideGripRate
      : steeringTuning.normalGripRate;
    const gripAlpha = clamp(-Math.expm1(-gripRate * timestepSeconds), 0, 1);
    lateralGripDeltaVelocity = scale(
      surfaceBasis.right,
      -surfaceLateralSpeed * gripAlpha,
    );

    const curvatureMagnitude = evaluateSteeringCurvatureCurve(
      steeringTuning.curvatureCurve,
      Math.abs(surfaceForwardSpeed),
    );
    const baseCurvature = normalizedSteer * curvatureMagnitude;
    const commandedCurvature = powerslideActive
      ? baseCurvature * steeringTuning.powerslideCurvatureMultiplier
      : baseCurvature;
    const currentYawRate = dot(angularVelocity, surfaceBasis.normal);
    const targetYawRate = clamp(
      commandedCurvature * surfaceForwardSpeed,
      -maximumAngularSpeed,
      maximumAngularSpeed,
    );
    angularDeltaVelocity = scale(
      surfaceBasis.normal,
      targetYawRate - currentYawRate,
    );
    groundedControl = {
      basis: surfaceBasis,
      surfaceForwardSpeed,
      surfaceLateralSpeed,
      powerslideActive,
      gripRate,
      gripAlpha,
      baseCurvature,
      commandedCurvature,
      currentYawRate,
      targetYawRate,
    };
  }

  const projectedVelocity = add(
    add(propulsionProjectedVelocity, dragDeltaVelocity),
    lateralGripDeltaVelocity,
  );
  const deltaVelocity = add(
    add(appliedPropulsionDeltaVelocity, dragDeltaVelocity),
    lateralGripDeltaVelocity,
  );
  const projectedAngularVelocity = add(angularVelocity, angularDeltaVelocity);

  return {
    localForward,
    forwardSpeed,
    normalizedThrottle,
    normalizedSteer,
    throttleAcceleration,
    boostAcceleration,
    dragAcceleration,
    requestedPropulsionAcceleration,
    requestedPropulsionDeltaVelocity,
    appliedPropulsionDeltaVelocity,
    dragDeltaVelocity,
    lateralGripDeltaVelocity,
    deltaVelocity,
    angularDeltaVelocity,
    propulsionProjectedVelocity,
    projectedVelocity,
    projectedAngularVelocity,
    propulsionProjectedForwardSpeed,
    boostActuated,
    groundedControl,
    nextFiniteState: {
      rotation,
      linearVelocity: projectedVelocity,
      angularVelocity: projectedAngularVelocity,
    },
  };
}
