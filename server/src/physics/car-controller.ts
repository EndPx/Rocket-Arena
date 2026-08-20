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

export interface CarJumpAirState {
  readonly lastConsumedJumpSequence: number;
  readonly firstJumpAcceptedAtStep: number | null;
  /** Distinguishes residual launch support from a later landing contact. */
  readonly airborneSinceFirstJump: boolean;
  readonly firstJumpHeld: boolean;
  readonly secondJumpAvailable: boolean;
  readonly activeFlipStartedAtStep: number | null;
  readonly activeFlipDirection: readonly [pitch: number, roll: number] | null;
}

export type JumpAirEvent =
  | 'none'
  | 'first-jump'
  | 'second-jump'
  | 'flip-start'
  | 'edge-discarded';

export interface JumpAirPlanningContext {
  readonly observation: CarControllerObservation;
  readonly fixedStepIndex: number;
  readonly timestepSeconds?: number;
  readonly tuning?: CarControllerTuningSnapshot;
}

export interface JumpAirControlPlan {
  readonly event: JumpAirEvent;
  readonly localForward: ControllerVector3;
  readonly localRight: ControllerVector3;
  readonly localRoof: ControllerVector3;
  readonly normalizedPitch: number;
  readonly normalizedYaw: number;
  readonly normalizedRoll: number;
  readonly jumpDeltaVelocity: ControllerVector3;
  readonly holdForce: ControllerVector3;
  readonly holdDeltaVelocity: ControllerVector3;
  readonly airAngularTarget: ControllerVector3;
  readonly flipActive: boolean;
  readonly nextState: Readonly<CarJumpAirState>;
}

export interface CarJumpAirPlanningBundle {
  readonly state: Readonly<CarJumpAirState>;
  readonly fixedStepIndex: number;
}

export interface CarControllerPlanningContext {
  readonly observation: CarControllerObservation;
  /** Authoritative inventory supplied by the caller. This planner never mutates it. */
  readonly availableBoost: number;
  readonly previousFiniteState?: CarControllerFiniteState;
  readonly tuning?: CarControllerTuningSnapshot;
  readonly timestepSeconds?: number;
  readonly dragEnabled?: boolean;
  /** Live no-wall-driving policy; pure future-surface tests leave this disabled. */
  readonly uprightRecoveryEnabled?: boolean;
  /** Optional near-contact basis used only for angular self-righting, never traction. */
  readonly uprightRecoveryBasis?: ControllerSurfaceBasis | null;
  /** Optional until Wave 17 owns one immutable action state per live car. */
  readonly jumpAir?: CarJumpAirPlanningBundle;
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
  /** Authoritative inventory cost for this fixed step; committed only after apply succeeds. */
  readonly boostConsumed: number;
  readonly groundedControl: GroundedControlPlan | null;
  readonly jumpAirControl: JumpAirControlPlan | null;
  readonly nextJumpAirState: Readonly<CarJumpAirState> | null;
  readonly nextFiniteState: CarControllerFiniteState;
}

const ZERO_VECTOR: ControllerVector3 = Object.freeze({ x: 0, y: 0, z: 0 });
const WORLD_UP: ControllerVector3 = Object.freeze({ x: 0, y: 1, z: 0 });
const IDENTITY_ROTATION: ControllerQuaternion = Object.freeze({ x: 0, y: 0, z: 0, w: 1 });
const CURVE_EPSILON = 1e-12;
const UPRIGHT_RECOVERY_STRENGTH = 7;
const UPRIGHT_RECOVERY_RESPONSE = 12;
const UPRIGHT_RECOVERY_MAX_ANGULAR_SPEED = 4.5;

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

function clampVectorMagnitude(
  value: ControllerVector3,
  maximumMagnitude: number,
): ControllerVector3 {
  const length = Math.hypot(value.x, value.y, value.z);
  if (!Number.isFinite(length) || length <= CURVE_EPSILON) return ZERO_VECTOR;
  return length > maximumMagnitude
    ? scale(value, maximumMagnitude / length)
    : value;
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

interface JumpAirTuning {
  readonly mass: number;
  readonly firstJumpVelocityChange: number;
  readonly holdForce: number;
  readonly holdDuration: number;
  readonly secondJumpWindow: number;
  readonly flipActuationWindow: number;
  readonly directionalDeadzone: number;
  readonly maximumAngularSpeed: number;
}

function readJumpAirTuning(tuning: CarControllerTuningSnapshot): JumpAirTuning {
  return {
    mass: getScalarTuningValue(tuning, TUNING_IDS.car.mass),
    firstJumpVelocityChange: getScalarTuningValue(
      tuning,
      TUNING_IDS.car.jump.firstVelocityChange,
    ),
    holdForce: getScalarTuningValue(tuning, TUNING_IDS.car.jump.holdForce),
    holdDuration: getScalarTuningValue(tuning, TUNING_IDS.car.jump.holdDuration),
    secondJumpWindow: getScalarTuningValue(tuning, TUNING_IDS.car.jump.secondJumpWindow),
    flipActuationWindow: getScalarTuningValue(
      tuning,
      TUNING_IDS.car.jump.flipActuationWindow,
    ),
    directionalDeadzone: getScalarTuningValue(
      tuning,
      TUNING_IDS.car.jump.directionalDeadzone,
    ),
    maximumAngularSpeed: getScalarTuningValue(tuning, TUNING_IDS.car.maxAngularSpeed),
  };
}

function validJumpAirTuning(candidate: JumpAirTuning): boolean {
  return Object.values(candidate).every(Number.isFinite)
    && candidate.mass > 0
    && candidate.firstJumpVelocityChange > 0
    && candidate.holdForce >= 0
    && candidate.holdDuration >= 0
    && candidate.secondJumpWindow >= 0
    && candidate.flipActuationWindow >= 0
    && candidate.directionalDeadzone >= 0
    && candidate.directionalDeadzone <= 1
    && candidate.maximumAngularSpeed > 0;
}

function resolveJumpAirTuning(tuning: CarControllerTuningSnapshot): JumpAirTuning {
  const fallback = readJumpAirTuning(DEFAULT_TUNING_REGISTRY_SNAPSHOT);
  try {
    const candidate = readJumpAirTuning(tuning);
    if (validJumpAirTuning(candidate)) return candidate;
  } catch {
    // Fall through to the immutable grouped fallback.
  }
  return fallback;
}

function finiteAxis(value: number): number {
  return Number.isFinite(value) ? clamp(value, -1, 1) : 0;
}

function finiteSequence(value: number, fallback: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function finiteStep(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function optionalStep(value: number | null): number | null {
  return value !== null && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function normalizedFlipDirection(
  value: readonly [number, number] | null,
): readonly [number, number] | null {
  if (value === null || !value.every(Number.isFinite)) return null;
  const magnitude = Math.hypot(value[0], value[1]);
  if (magnitude <= CURVE_EPSILON) return null;
  return Object.freeze([value[0] / magnitude, value[1] / magnitude] as const);
}

function immutableJumpAirState(state: CarJumpAirState): Readonly<CarJumpAirState> {
  return Object.freeze({
    ...state,
    activeFlipDirection: normalizedFlipDirection(state.activeFlipDirection),
  });
}

function sanitizeJumpAirState(state: Readonly<CarJumpAirState>): Readonly<CarJumpAirState> {
  const lastConsumedJumpSequence = finiteSequence(state.lastConsumedJumpSequence, 0);
  const firstJumpAcceptedAtStep = optionalStep(state.firstJumpAcceptedAtStep);
  const airborneSinceFirstJump = firstJumpAcceptedAtStep !== null
    && state.airborneSinceFirstJump === true;
  const activeFlipDirection = normalizedFlipDirection(state.activeFlipDirection);
  const activeFlipStartedAtStep = activeFlipDirection === null
    ? null
    : optionalStep(state.activeFlipStartedAtStep);
  return immutableJumpAirState({
    lastConsumedJumpSequence,
    firstJumpAcceptedAtStep,
    airborneSinceFirstJump,
    firstJumpHeld: state.firstJumpHeld === true,
    secondJumpAvailable: state.secondJumpAvailable === true,
    activeFlipStartedAtStep,
    activeFlipDirection: activeFlipStartedAtStep === null ? null : activeFlipDirection,
  });
}

export function createCarJumpAirState(
  consumedFloor = 0,
): Readonly<CarJumpAirState> {
  return immutableJumpAirState({
    lastConsumedJumpSequence: finiteSequence(consumedFloor, 0),
    firstJumpAcceptedAtStep: null,
    airborneSinceFirstJump: false,
    firstJumpHeld: false,
    secondJumpAvailable: false,
    activeFlipStartedAtStep: null,
    activeFlipDirection: null,
  });
}

/** Consume disabled-phase edges without queueing jump, hold, or flip actuation. */
export function synchronizeCarJumpAirState(
  state: Readonly<CarJumpAirState>,
  input: Readonly<InputCommandV2>,
): Readonly<CarJumpAirState> {
  const safeState = sanitizeJumpAirState(state);
  return immutableJumpAirState({
    lastConsumedJumpSequence: Math.max(
      safeState.lastConsumedJumpSequence,
      finiteSequence(input.jumpSequence, safeState.lastConsumedJumpSequence),
    ),
    firstJumpAcceptedAtStep: null,
    airborneSinceFirstJump: false,
    firstJumpHeld: false,
    secondJumpAvailable: false,
    activeFlipStartedAtStep: null,
    activeFlipDirection: null,
  });
}

function boundedAngularTarget(
  raw: ControllerVector3,
  maximumAngularSpeed: number,
): ControllerVector3 {
  const magnitude = Math.hypot(raw.x, raw.y, raw.z);
  if (!Number.isFinite(magnitude) || magnitude <= CURVE_EPSILON) return ZERO_VECTOR;
  return scale(raw, maximumAngularSpeed / Math.max(1, magnitude));
}

/** Plan one fixed-step jump, hold, flip, and local-axis air-control command. */
export function planJumpAirControl(
  input: Readonly<InputCommandV2>,
  state: Readonly<CarJumpAirState>,
  context: Readonly<JumpAirPlanningContext>,
): Readonly<JumpAirControlPlan> {
  const tuningSnapshot = context.tuning ?? DEFAULT_TUNING_REGISTRY_SNAPSHOT;
  const tuning = resolveJumpAirTuning(tuningSnapshot);
  const timestepSeconds = Number.isFinite(context.timestepSeconds)
    && (context.timestepSeconds as number) > 0
    ? context.timestepSeconds as number
    : resolveScalar(
      tuningSnapshot,
      TUNING_IDS.physics.fixedStepSeconds,
      (value) => value > 0,
    );
  const fixedStepIndex = finiteStep(context.fixedStepIndex);
  const rotation = finiteQuaternion(context.observation.rotation) ?? IDENTITY_ROTATION;
  const localForward = rotateVector(rotation, { x: 0, y: 0, z: 1 });
  const localRight = rotateVector(rotation, { x: 1, y: 0, z: 0 });
  const localRoof = rotateVector(rotation, { x: 0, y: 1, z: 0 });
  const normalizedPitch = finiteAxis(input.pitch);
  const normalizedYaw = finiteAxis(input.yaw);
  const normalizedRoll = finiteAxis(input.roll);
  let nextState = sanitizeJumpAirState(state);
  let event: JumpAirEvent = 'none';
  let jumpDeltaVelocity: ControllerVector3 = ZERO_VECTOR;

  const firstJumpStepAtStart = nextState.firstJumpAcceptedAtStep;
  const elapsedFirstAtStart = firstJumpStepAtStart === null
    ? Number.POSITIVE_INFINITY
    : (fixedStepIndex - firstJumpStepAtStart) * timestepSeconds;
  const residualLaunchSupport = context.observation.grounded === true
    && firstJumpStepAtStart !== null
    && nextState.airborneSinceFirstJump === false
    && elapsedFirstAtStart >= -CURVE_EPSILON
    && elapsedFirstAtStart <= tuning.secondJumpWindow + CURVE_EPSILON;

  if (context.observation.grounded === true && !residualLaunchSupport) {
    nextState = immutableJumpAirState({
      lastConsumedJumpSequence: nextState.lastConsumedJumpSequence,
      firstJumpAcceptedAtStep: null,
      airborneSinceFirstJump: false,
      firstJumpHeld: false,
      secondJumpAvailable: true,
      activeFlipStartedAtStep: null,
      activeFlipDirection: null,
    });
  } else if (context.observation.grounded !== true) {
    if (
      nextState.firstJumpAcceptedAtStep !== null
      && nextState.airborneSinceFirstJump === false
    ) {
      nextState = immutableJumpAirState({
        ...nextState,
        airborneSinceFirstJump: true,
      });
    }
    if (nextState.activeFlipStartedAtStep !== null) {
      const elapsedFlip = (fixedStepIndex - nextState.activeFlipStartedAtStep) * timestepSeconds;
      if (elapsedFlip + CURVE_EPSILON >= tuning.flipActuationWindow) {
        nextState = immutableJumpAirState({
          ...nextState,
          activeFlipStartedAtStep: null,
          activeFlipDirection: null,
        });
      }
    }
  }

  if (input.jumpHeld !== true && nextState.firstJumpHeld) {
    nextState = immutableJumpAirState({ ...nextState, firstJumpHeld: false });
  }

  const jumpSequence = finiteSequence(
    input.jumpSequence,
    nextState.lastConsumedJumpSequence,
  );
  if (jumpSequence > nextState.lastConsumedJumpSequence) {
    nextState = immutableJumpAirState({
      ...nextState,
      lastConsumedJumpSequence: jumpSequence,
      firstJumpHeld: false,
    });

    if (context.observation.grounded === true && !residualLaunchSupport) {
      event = 'first-jump';
      jumpDeltaVelocity = scale(localRoof, tuning.firstJumpVelocityChange);
      nextState = immutableJumpAirState({
        ...nextState,
        firstJumpAcceptedAtStep: fixedStepIndex,
        airborneSinceFirstJump: false,
        firstJumpHeld: input.jumpHeld === true,
        secondJumpAvailable: true,
        activeFlipStartedAtStep: null,
        activeFlipDirection: null,
      });
    } else if (context.observation.grounded !== true) {
      const firstJumpStep = nextState.firstJumpAcceptedAtStep;
      const elapsedFirst = firstJumpStep === null
        ? Number.POSITIVE_INFINITY
        : (fixedStepIndex - firstJumpStep) * timestepSeconds;
      const secondJumpLegal = nextState.secondJumpAvailable
        && firstJumpStep !== null
        && elapsedFirst >= -CURVE_EPSILON
        && elapsedFirst <= tuning.secondJumpWindow + CURVE_EPSILON;
      if (secondJumpLegal) {
        const directionMagnitude = Math.hypot(normalizedPitch, normalizedRoll);
        const directional = directionMagnitude > CURVE_EPSILON
          && directionMagnitude + CURVE_EPSILON >= tuning.directionalDeadzone;
        if (directional) {
          event = 'flip-start';
          const lockedDirection = Object.freeze([
            normalizedPitch / directionMagnitude,
            normalizedRoll / directionMagnitude,
          ] as const);
          const planarDirection = normalizeVector(add(
            scale(localForward, lockedDirection[0]),
            scale(localRight, -lockedDirection[1]),
          )) ?? localForward;
          const flipDirection = normalizeVector(add(localRoof, planarDirection)) ?? localRoof;
          jumpDeltaVelocity = scale(flipDirection, tuning.firstJumpVelocityChange);
          nextState = immutableJumpAirState({
            ...nextState,
            secondJumpAvailable: false,
            activeFlipStartedAtStep: fixedStepIndex,
            activeFlipDirection: lockedDirection,
          });
        } else {
          event = 'second-jump';
          jumpDeltaVelocity = scale(localRoof, tuning.firstJumpVelocityChange);
          nextState = immutableJumpAirState({
            ...nextState,
            secondJumpAvailable: false,
            activeFlipStartedAtStep: null,
            activeFlipDirection: null,
          });
        }
      } else {
        event = 'edge-discarded';
      }
    } else {
      // A launch is already in flight even if support rays still reach the old surface.
      event = 'edge-discarded';
    }
  }

  let firstJumpStep = nextState.firstJumpAcceptedAtStep;
  let elapsedFirst = firstJumpStep === null
    ? Number.POSITIVE_INFINITY
    : (fixedStepIndex - firstJumpStep) * timestepSeconds;
  if (
    nextState.firstJumpHeld
    && elapsedFirst + CURVE_EPSILON >= tuning.holdDuration
  ) {
    nextState = immutableJumpAirState({ ...nextState, firstJumpHeld: false });
    firstJumpStep = nextState.firstJumpAcceptedAtStep;
    elapsedFirst = firstJumpStep === null
      ? Number.POSITIVE_INFINITY
      : (fixedStepIndex - firstJumpStep) * timestepSeconds;
  }
  const holdActive = nextState.firstJumpHeld
    && input.jumpHeld === true
    && elapsedFirst >= -CURVE_EPSILON
    && elapsedFirst + CURVE_EPSILON < tuning.holdDuration;
  const holdForce = holdActive ? scale(localRoof, tuning.holdForce) : ZERO_VECTOR;
  const holdDeltaVelocity = holdActive
    ? scale(localRoof, tuning.holdForce / tuning.mass * timestepSeconds)
    : ZERO_VECTOR;

  let flipActive = false;
  let pitchCommand = normalizedPitch;
  let rollCommand = normalizedRoll;
  if (
    context.observation.grounded !== true
    && nextState.activeFlipStartedAtStep !== null
    && nextState.activeFlipDirection !== null
  ) {
    const elapsedFlip = (fixedStepIndex - nextState.activeFlipStartedAtStep) * timestepSeconds;
    flipActive = elapsedFlip >= -CURVE_EPSILON
      && elapsedFlip + CURVE_EPSILON < tuning.flipActuationWindow;
    if (flipActive) {
      [pitchCommand, rollCommand] = nextState.activeFlipDirection;
    }
  }

  const rawAirAngular = context.observation.grounded === true
    ? ZERO_VECTOR
    : add(
      add(scale(localRight, pitchCommand), scale(localRoof, normalizedYaw)),
      scale(localForward, rollCommand),
    );
  const airAngularTarget = boundedAngularTarget(
    rawAirAngular,
    tuning.maximumAngularSpeed,
  );

  return Object.freeze({
    event,
    localForward,
    localRight,
    localRoof,
    normalizedPitch,
    normalizedYaw,
    normalizedRoll,
    jumpDeltaVelocity,
    holdForce,
    holdDeltaVelocity,
    airAngularTarget,
    flipActive,
    nextState,
  });
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
  const boostConsumptionPerSecond = resolveScalar(
    tuning,
    TUNING_IDS.car.boost.consumptionPerSecond,
    (value) => value > 0,
  );
  const fullStepBoostCost = boostConsumptionPerSecond * timestepSeconds;
  const boostConsumed = input.boostHeld === true
    ? Math.min(availableBoost, fullStepBoostCost)
    : 0;
  const boostActuated = boostConsumed > 0;
  const boostActuationFraction = fullStepBoostCost > 0
    ? boostConsumed / fullStepBoostCost
    : 0;
  const boostAccelerationMagnitude = resolveScalar(
    tuning,
    TUNING_IDS.car.boost.acceleration,
    (value) => value > 0,
  );
  const boostAcceleration = boostActuated
    ? scale(localForward, boostAccelerationMagnitude * boostActuationFraction)
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
    const yawDeltaVelocity = scale(
      surfaceBasis.normal,
      targetYawRate - currentYawRate,
    );

    angularDeltaVelocity = yawDeltaVelocity;
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

  const baseProjectedVelocity = add(
    add(propulsionProjectedVelocity, dragDeltaVelocity),
    lateralGripDeltaVelocity,
  );
  const baseDeltaVelocity = add(
    add(appliedPropulsionDeltaVelocity, dragDeltaVelocity),
    lateralGripDeltaVelocity,
  );
  let projectedVelocity = baseProjectedVelocity;
  let deltaVelocity = baseDeltaVelocity;
  let projectedAngularVelocity = add(angularVelocity, angularDeltaVelocity);
  let finalAngularDeltaVelocity = angularDeltaVelocity;
  let jumpAirControl: JumpAirControlPlan | null = null;
  let nextJumpAirState: Readonly<CarJumpAirState> | null = null;

  if (context.jumpAir !== undefined) {
    jumpAirControl = planJumpAirControl(input, context.jumpAir.state, {
      observation: {
        ...context.observation,
        rotation,
        linearVelocity,
        angularVelocity,
      },
      fixedStepIndex: context.jumpAir.fixedStepIndex,
      timestepSeconds,
      tuning,
    });
    nextJumpAirState = jumpAirControl.nextState;
    const jumpLinearDelta = add(
      jumpAirControl.jumpDeltaVelocity,
      jumpAirControl.holdDeltaVelocity,
    );
    projectedVelocity = add(baseProjectedVelocity, jumpLinearDelta);
    deltaVelocity = add(baseDeltaVelocity, jumpLinearDelta);
    if (context.observation.grounded !== true) {
      const hasExplicitAirAngularCommand = jumpAirControl.flipActive
        || Math.abs(jumpAirControl.normalizedPitch) > CURVE_EPSILON
        || Math.abs(jumpAirControl.normalizedYaw) > CURVE_EPSILON
        || Math.abs(jumpAirControl.normalizedRoll) > CURVE_EPSILON;
      projectedAngularVelocity = hasExplicitAirAngularCommand
        ? jumpAirControl.airAngularTarget
        : angularVelocity;
      finalAngularDeltaVelocity = subtract(projectedAngularVelocity, angularVelocity);
    }
  }

  const recoveryBasis = context.uprightRecoveryBasis === undefined
    ? surfaceBasis
    : resolveSurfaceBasis(context.uprightRecoveryBasis, localForward);
  const explicitAirAngularCommand = context.observation.grounded !== true
    && jumpAirControl !== null
    && (
      jumpAirControl.flipActive
      || Math.abs(jumpAirControl.normalizedPitch) > CURVE_EPSILON
      || Math.abs(jumpAirControl.normalizedYaw) > CURVE_EPSILON
      || Math.abs(jumpAirControl.normalizedRoll) > CURVE_EPSILON
    );
  if (
    context.uprightRecoveryEnabled === true
    && recoveryBasis !== null
    && !explicitAirAngularCommand
  ) {
    const localRoof = rotateVector(rotation, WORLD_UP);
    let recoveryAxis = cross(localRoof, recoveryBasis.normal);
    if (
      Math.hypot(recoveryAxis.x, recoveryAxis.y, recoveryAxis.z) <= CURVE_EPSILON
      && dot(localRoof, recoveryBasis.normal) < 0
    ) {
      recoveryAxis = recoveryBasis.forward;
    }
    let uprightTarget = scale(recoveryAxis, UPRIGHT_RECOVERY_STRENGTH);
    const targetMagnitude = Math.hypot(
      uprightTarget.x,
      uprightTarget.y,
      uprightTarget.z,
    );
    if (targetMagnitude > UPRIGHT_RECOVERY_MAX_ANGULAR_SPEED) {
      uprightTarget = scale(
        uprightTarget,
        UPRIGHT_RECOVERY_MAX_ANGULAR_SPEED / targetMagnitude,
      );
    }
    const currentNormalRate = dot(projectedAngularVelocity, recoveryBasis.normal);
    const currentTangent = subtract(
      projectedAngularVelocity,
      scale(recoveryBasis.normal, currentNormalRate),
    );
    const targetTangent = subtract(
      uprightTarget,
      scale(recoveryBasis.normal, dot(uprightTarget, recoveryBasis.normal)),
    );
    const recoveryAlpha = clamp(
      -Math.expm1(-UPRIGHT_RECOVERY_RESPONSE * timestepSeconds),
      0,
      1,
    );
    projectedAngularVelocity = add(
      projectedAngularVelocity,
      scale(subtract(targetTangent, currentTangent), recoveryAlpha),
    );
    projectedAngularVelocity = clampVectorMagnitude(
      projectedAngularVelocity,
      maximumAngularSpeed,
    );
    finalAngularDeltaVelocity = subtract(projectedAngularVelocity, angularVelocity);
  }

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
    angularDeltaVelocity: finalAngularDeltaVelocity,
    propulsionProjectedVelocity,
    projectedVelocity,
    projectedAngularVelocity,
    propulsionProjectedForwardSpeed,
    boostActuated,
    boostConsumed,
    groundedControl,
    jumpAirControl,
    nextJumpAirState,
    nextFiniteState: {
      rotation,
      linearVelocity: projectedVelocity,
      angularVelocity: projectedAngularVelocity,
    },
  };
}
