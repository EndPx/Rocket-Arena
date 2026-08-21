import * as THREE from 'three';
import {
  DEFAULT_TUNING_REGISTRY_SNAPSHOT,
  TUNING_IDS,
  VISUAL,
  type FiniteRange,
  type TuningRegistrySnapshot,
} from '@rocket-arena/shared';

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const LOCAL_UP = new THREE.Vector3(0, 1, 0);
const LOCAL_FORWARD = new THREE.Vector3(0, 0, 1);
const LOCAL_RIGHT = new THREE.Vector3(1, 0, 0);
/**
 * A chassis axis is only usable as a heading source when its ground projection
 * keeps this much squared length, which corresponds to roughly 26 degrees away
 * from vertical. Below that the projection direction is dominated by noise.
 */
const HEADING_PROJECTION_MINIMUM_LENGTH_SQUARED = 0.2;
const FLIP_CAMERA_PULLBACK_DISTANCE = 3;
const FLIP_CAMERA_PULLBACK_RESPONSE = 8;
const MAX_DELTA_SECONDS = 0.1;
const MAX_SAFE_WORLD_COORDINATE = 1_000_000_000;
const VECTOR_EPSILON_SQUARED = 1e-10;
const VECTOR_EPSILON = 1e-5;

export type GameplayCameraMode = 'ball' | 'car';
export type CameraMode = 'orbit' | GameplayCameraMode;

export interface BallCameraConfiguration {
  readonly distance: number;
  readonly height: number;
  readonly lookAhead: number;
  readonly fieldOfViewDegrees: number;
}

export interface CarCameraConfiguration {
  readonly distance: number;
  readonly height: number;
  readonly stiffness: number;
  readonly damping: number;
  readonly lookAhead: number;
  readonly fieldOfViewDegrees: number;
}

export interface CameraConfiguration {
  readonly ball: Readonly<BallCameraConfiguration>;
  readonly car: Readonly<CarCameraConfiguration>;
}

export interface CameraFrameInput {
  readonly camera: THREE.PerspectiveCamera;
  readonly localCar: THREE.Object3D | null;
  readonly ball: THREE.Object3D | null;
  readonly elapsedSeconds: number;
  readonly deltaSeconds: number;
  readonly activePlay: boolean;
  readonly cameraToggleSequence: number;
  /** Epoch from the sampled interpolation frame, never from a newer accepted snapshot. */
  readonly presentedKickoffEpoch: number | null;
}

export interface CameraUpdateOptions {
  readonly ball?: THREE.Object3D | null;
  readonly activePlay?: boolean;
  readonly cameraToggleSequence?: number;
  readonly presentedKickoffEpoch?: number | null;
}

interface CameraConfigurationRanges {
  readonly ball: {
    readonly distance: FiniteRange;
    readonly height: FiniteRange;
    readonly lookAhead: FiniteRange;
    readonly fieldOfViewDegrees: FiniteRange;
  };
  readonly car: {
    readonly distance: FiniteRange;
    readonly height: FiniteRange;
    readonly stiffness: FiniteRange;
    readonly damping: FiniteRange;
    readonly lookAhead: FiniteRange;
    readonly fieldOfViewDegrees: FiniteRange;
  };
}

function scalarEntry(
  snapshot: Pick<TuningRegistrySnapshot, 'get'>,
  id: string,
): Readonly<{ readonly value: number; readonly validatedRange: FiniteRange }> {
  const entry = snapshot.get(id);
  if (entry?.kind !== 'scalar') {
    throw new TypeError(`Camera tuning entry ${id} must be scalar.`);
  }
  return entry;
}

function cloneRange(range: FiniteRange): FiniteRange {
  return Object.freeze({ min: range.min, max: range.max });
}

const CAMERA_CONFIGURATION_RANGES: CameraConfigurationRanges = (() => {
  const range = (id: string): FiniteRange => cloneRange(
    scalarEntry(DEFAULT_TUNING_REGISTRY_SNAPSHOT, id).validatedRange,
  );
  return Object.freeze({
    ball: Object.freeze({
      distance: range(TUNING_IDS.camera.ball.distance),
      height: range(TUNING_IDS.camera.ball.height),
      lookAhead: range(TUNING_IDS.camera.ball.lookAhead),
      fieldOfViewDegrees: range(TUNING_IDS.camera.ball.fieldOfViewDegrees),
    }),
    car: Object.freeze({
      distance: range(TUNING_IDS.camera.spring.distance),
      height: range(TUNING_IDS.camera.spring.height),
      stiffness: range(TUNING_IDS.camera.spring.stiffness),
      damping: range(TUNING_IDS.camera.spring.damping),
      lookAhead: range(TUNING_IDS.camera.spring.lookAhead),
      fieldOfViewDegrees: range(TUNING_IDS.camera.spring.fieldOfViewDegrees),
    }),
  });
})();

function configurationFromSnapshot(
  snapshot: Pick<TuningRegistrySnapshot, 'get'>,
): CameraConfiguration {
  return {
    ball: {
      distance: scalarEntry(snapshot, TUNING_IDS.camera.ball.distance).value,
      height: scalarEntry(snapshot, TUNING_IDS.camera.ball.height).value,
      lookAhead: scalarEntry(snapshot, TUNING_IDS.camera.ball.lookAhead).value,
      fieldOfViewDegrees: scalarEntry(
        snapshot,
        TUNING_IDS.camera.ball.fieldOfViewDegrees,
      ).value,
    },
    car: {
      distance: scalarEntry(snapshot, TUNING_IDS.camera.spring.distance).value,
      height: scalarEntry(snapshot, TUNING_IDS.camera.spring.height).value,
      stiffness: scalarEntry(snapshot, TUNING_IDS.camera.spring.stiffness).value,
      damping: scalarEntry(snapshot, TUNING_IDS.camera.spring.damping).value,
      lookAhead: scalarEntry(snapshot, TUNING_IDS.camera.spring.lookAhead).value,
      fieldOfViewDegrees: scalarEntry(
        snapshot,
        TUNING_IDS.camera.spring.fieldOfViewDegrees,
      ).value,
    },
  };
}

function finiteInRange(value: unknown, range: FiniteRange): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= range.min
    && value <= range.max;
}

const INVALID_CONFIGURATION_PROPERTY = Symbol('invalid-camera-configuration-property');

function ownDataProperty(candidate: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
    return descriptor !== undefined && 'value' in descriptor
      ? descriptor.value
      : INVALID_CONFIGURATION_PROPERTY;
  } catch {
    return INVALID_CONFIGURATION_PROPERTY;
  }
}

function validatedConfiguration(candidate: unknown): CameraConfiguration | null {
  if (typeof candidate !== 'object' || candidate === null) return null;

  const ballCandidate = ownDataProperty(candidate, 'ball');
  const carCandidate = ownDataProperty(candidate, 'car');
  if (typeof ballCandidate !== 'object' || ballCandidate === null) return null;
  if (typeof carCandidate !== 'object' || carCandidate === null) return null;

  // Read only own data properties, exactly once. This keeps validation and publication on
  // the same immutable scalar snapshot and rejects stateful accessors or hostile proxies.
  const ballDistance = ownDataProperty(ballCandidate, 'distance');
  const ballHeight = ownDataProperty(ballCandidate, 'height');
  const ballLookAhead = ownDataProperty(ballCandidate, 'lookAhead');
  const ballFieldOfViewDegrees = ownDataProperty(ballCandidate, 'fieldOfViewDegrees');
  const carDistance = ownDataProperty(carCandidate, 'distance');
  const carHeight = ownDataProperty(carCandidate, 'height');
  const carStiffness = ownDataProperty(carCandidate, 'stiffness');
  const carDamping = ownDataProperty(carCandidate, 'damping');
  const carLookAhead = ownDataProperty(carCandidate, 'lookAhead');
  const carFieldOfViewDegrees = ownDataProperty(carCandidate, 'fieldOfViewDegrees');

  const ranges = CAMERA_CONFIGURATION_RANGES;
  if (
    !finiteInRange(ballDistance, ranges.ball.distance)
    || !finiteInRange(ballHeight, ranges.ball.height)
    || !finiteInRange(ballLookAhead, ranges.ball.lookAhead)
    || !finiteInRange(ballFieldOfViewDegrees, ranges.ball.fieldOfViewDegrees)
    || !finiteInRange(carDistance, ranges.car.distance)
    || !finiteInRange(carHeight, ranges.car.height)
    || !finiteInRange(carStiffness, ranges.car.stiffness)
    || !finiteInRange(carDamping, ranges.car.damping)
    || !finiteInRange(carLookAhead, ranges.car.lookAhead)
    || !finiteInRange(carFieldOfViewDegrees, ranges.car.fieldOfViewDegrees)
  ) {
    return null;
  }

  return Object.freeze({
    ball: Object.freeze({
      distance: ballDistance,
      height: ballHeight,
      lookAhead: ballLookAhead,
      fieldOfViewDegrees: ballFieldOfViewDegrees,
    }),
    car: Object.freeze({
      distance: carDistance,
      height: carHeight,
      stiffness: carStiffness,
      damping: carDamping,
      lookAhead: carLookAhead,
      fieldOfViewDegrees: carFieldOfViewDegrees,
    }),
  });
}

const defaultConfiguration = validatedConfiguration(
  configurationFromSnapshot(DEFAULT_TUNING_REGISTRY_SNAPSHOT),
);
if (defaultConfiguration === null) {
  throw new TypeError('Default camera tuning registry values are invalid.');
}

export const DEFAULT_CAMERA_CONFIGURATION: CameraConfiguration = defaultConfiguration;

function validSequence(value: number): number | null {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function validEpoch(value: number | null): number | null {
  return value !== null && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function finiteDelta(value: number): number {
  return Number.isFinite(value)
    ? THREE.MathUtils.clamp(value, 0, MAX_DELTA_SECONDS)
    : 0;
}

function finiteElapsed(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function clampCoordinate(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return THREE.MathUtils.clamp(
    value,
    -MAX_SAFE_WORLD_COORDINATE,
    MAX_SAFE_WORLD_COORDINATE,
  );
}

function copyFinitePosition(target: THREE.Vector3, source: THREE.Vector3): THREE.Vector3 {
  return target.set(
    clampCoordinate(source.x),
    clampCoordinate(source.y),
    clampCoordinate(source.z),
  );
}

function clampVectorComponents(vector: THREE.Vector3): THREE.Vector3 {
  vector.set(
    clampCoordinate(vector.x),
    clampCoordinate(vector.y),
    clampCoordinate(vector.z),
  );
  return vector;
}

function finiteQuaternion(quaternion: THREE.Quaternion): boolean {
  return Number.isFinite(quaternion.x)
    && Number.isFinite(quaternion.y)
    && Number.isFinite(quaternion.z)
    && Number.isFinite(quaternion.w)
    && quaternion.lengthSq() > Number.EPSILON;
}

export function dampingAlpha(response: number, deltaSeconds: number): number {
  if (!Number.isFinite(response) || !Number.isFinite(deltaSeconds)) return 0;
  return 1 - Math.exp(-Math.max(0, response) * Math.max(0, deltaSeconds));
}

function springVector(
  current: THREE.Vector3,
  velocity: THREE.Vector3,
  target: THREE.Vector3,
  stiffness: number,
  damping: number,
  deltaSeconds: number,
): void {
  if (deltaSeconds <= 0) return;
  const denominator = 1
    + damping * deltaSeconds
    + stiffness * deltaSeconds * deltaSeconds;
  velocity
    .addScaledVector(target.clone().sub(current), stiffness * deltaSeconds)
    .divideScalar(denominator);
  current.addScaledVector(velocity, deltaSeconds);
  if (
    !Number.isFinite(current.x)
    || !Number.isFinite(current.y)
    || !Number.isFinite(current.z)
    || !Number.isFinite(velocity.x)
    || !Number.isFinite(velocity.y)
    || !Number.isFinite(velocity.z)
  ) {
    current.copy(target);
    velocity.set(0, 0, 0);
  }
}

/** Local-only camera state. No method mutates an input mesh or server state. */
export class CameraController {
  private modeValue: CameraMode = 'orbit';
  private configurationValue: CameraConfiguration = DEFAULT_CAMERA_CONFIGURATION;
  private activePlayEntered = false;
  private consumedCameraToggleSequenceValue = 0;
  private cameraModeTransitionCountValue = 0;
  private lastPresentedKickoffEpochValue: number | null = null;
  private historyInitialized = false;
  private historyNeedsRebase = true;
  private headingLockedForTilt = false;
  private flipPullbackAlpha = 0;

  private readonly carPosition = new THREE.Vector3();
  private readonly ballPosition = new THREE.Vector3();
  private readonly forward = new THREE.Vector3(0, 0, 1);
  private readonly forwardCandidate = new THREE.Vector3(0, 0, 1);
  private readonly rightDerivedForwardCandidate = new THREE.Vector3(0, 0, 1);
  private readonly lastForward = new THREE.Vector3(0, 0, 1);
  private readonly lastCarPosition = new THREE.Vector3();
  private readonly targetPosition = new THREE.Vector3();
  private readonly targetLookAt = new THREE.Vector3();
  private readonly smoothedLookAt = new THREE.Vector3();
  private readonly positionVelocity = new THREE.Vector3();
  private readonly lookVelocity = new THREE.Vector3();
  private readonly temporaryQuaternion = new THREE.Quaternion();
  private readonly temporaryVector = new THREE.Vector3();

  constructor(snapshot: Pick<TuningRegistrySnapshot, 'get'> = DEFAULT_TUNING_REGISTRY_SNAPSHOT) {
    if (snapshot !== DEFAULT_TUNING_REGISTRY_SNAPSHOT) this.applyTuningSnapshot(snapshot);
  }

  get mode(): CameraMode {
    return this.modeValue;
  }

  get configuration(): CameraConfiguration {
    return this.configurationValue;
  }

  get consumedCameraToggleSequence(): number {
    return this.consumedCameraToggleSequenceValue;
  }

  get cameraModeTransitionCount(): number {
    return this.cameraModeTransitionCountValue;
  }

  get lastPresentedKickoffEpoch(): number | null {
    return this.lastPresentedKickoffEpochValue;
  }

  setOrbitMode(): void {
    this.modeValue = 'orbit';
    this.activePlayEntered = false;
    this.lastPresentedKickoffEpochValue = null;
    this.resetHistory();
  }

  /** Prepare one room session; the first Active Play frame will still force Ball Camera. */
  beginGameplaySession(cameraToggleSequence = 0): void {
    this.modeValue = 'ball';
    this.activePlayEntered = false;
    this.consumedCameraToggleSequenceValue = validSequence(cameraToggleSequence) ?? 0;
    this.cameraModeTransitionCountValue = 0;
    this.lastPresentedKickoffEpochValue = null;
    this.resetHistory();
  }

  /** Compatibility/testing selector; runtime mode transitions should use input edges. */
  setGameplayMode(mode: GameplayCameraMode): void {
    this.modeValue = mode;
    this.activePlayEntered = true;
    this.resetHistory();
  }

  applyConfiguration(candidate: unknown): boolean {
    const validated = validatedConfiguration(candidate);
    if (validated === null) return false;
    this.configurationValue = validated;
    this.resetHistory();
    return true;
  }

  applyTuningSnapshot(snapshot: Pick<TuningRegistrySnapshot, 'get'>): boolean {
    try {
      return this.applyConfiguration(configurationFromSnapshot(snapshot));
    } catch {
      return false;
    }
  }

  update(input: CameraFrameInput): void {
    const { camera } = input;
    const deltaSeconds = finiteDelta(input.deltaSeconds);
    camera.up.copy(WORLD_UP);

    if (this.modeValue === 'orbit') {
      this.updateOrbit(camera, finiteElapsed(input.elapsedSeconds), deltaSeconds);
      return;
    }

    if (!this.activePlayEntered) {
      if (input.activePlay) {
        this.modeValue = 'ball';
        this.activePlayEntered = true;
        this.consumedCameraToggleSequenceValue = validSequence(
          input.cameraToggleSequence,
        ) ?? this.consumedCameraToggleSequenceValue;
        this.resetHistory();
      }
    } else {
      this.consumeCameraToggleSequence(input.cameraToggleSequence);
    }

    const presentedEpoch = validEpoch(input.presentedKickoffEpoch);
    if (
      presentedEpoch !== null
      && presentedEpoch !== this.lastPresentedKickoffEpochValue
    ) {
      this.lastPresentedKickoffEpochValue = presentedEpoch;
      this.resetHistory();
    }

    if (input.localCar === null) {
      this.updateOrbit(camera, finiteElapsed(input.elapsedSeconds), deltaSeconds);
      this.historyInitialized = false;
      return;
    }

    copyFinitePosition(this.carPosition, input.localCar.position);
    this.resolveForward(input.localCar);
    this.flipPullbackAlpha = THREE.MathUtils.lerp(
      this.flipPullbackAlpha,
      this.headingLockedForTilt ? 1 : 0,
      dampingAlpha(FLIP_CAMERA_PULLBACK_RESPONSE, deltaSeconds),
    );
    const teleported = this.historyInitialized
      && this.lastCarPosition.distanceToSquared(this.carPosition)
        > VISUAL.CAMERA.TELEPORT_DISTANCE ** 2;
    const rebase = this.historyNeedsRebase || !this.historyInitialized || teleported;

    if (this.modeValue === 'ball' && input.ball !== null) {
      copyFinitePosition(this.ballPosition, input.ball.position);
      this.updateBallCamera(camera, deltaSeconds, rebase);
    } else {
      this.updateCarCamera(camera, deltaSeconds, rebase);
    }

    this.lastCarPosition.copy(this.carPosition);
    this.lastForward.copy(this.forward);
    this.historyInitialized = true;
    this.historyNeedsRebase = false;
  }

  private consumeCameraToggleSequence(sequenceValue: number): void {
    const sequence = validSequence(sequenceValue);
    if (sequence === null || sequence <= this.consumedCameraToggleSequenceValue) return;

    const transitionCount = sequence - this.consumedCameraToggleSequenceValue;
    if (transitionCount % 2 === 1) {
      this.modeValue = this.modeValue === 'ball' ? 'car' : 'ball';
      // Keep the current camera transform and spring history so switching modes
      // converges into the new composition instead of snapping to a rebase.
      this.positionVelocity.set(0, 0, 0);
      this.lookVelocity.set(0, 0, 0);
    }
    this.consumedCameraToggleSequenceValue = sequence;
    this.cameraModeTransitionCountValue += transitionCount;
  }

  private resolveForward(car: THREE.Object3D): void {
    this.temporaryQuaternion.copy(car.quaternion);
    if (!finiteQuaternion(this.temporaryQuaternion)) {
      this.forward.copy(this.lastForward);
      return;
    }

    this.temporaryQuaternion.normalize();

    // The chase heading must come from whichever chassis axis is currently the
    // most horizontal, because that is the axis whose ground projection is
    // numerically stable.
    //
    // An air roll spins the chassis about its own forward axis: forward stays
    // horizontal while right sweeps through vertical twice per revolution.
    // Choosing between the two candidates by nearest-previous-heading therefore
    // oscillated during every roll, and the chassis-up heading lock switched on
    // and off as the roll passed through inverted, so the view swung back and
    // forth. Selecting by verticality is monotonic through a roll and still
    // hands over to the right-derived heading during a front or back flip,
    // where it is forward that crosses vertical.
    this.forwardCandidate
      .copy(LOCAL_FORWARD)
      .applyQuaternion(this.temporaryQuaternion);
    const chassisForwardVerticality = Math.abs(this.forwardCandidate.y);
    this.forwardCandidate.y = 0;
    const forwardLengthSquared = this.forwardCandidate.lengthSq();
    const forwardValid = Number.isFinite(forwardLengthSquared)
      && forwardLengthSquared > HEADING_PROJECTION_MINIMUM_LENGTH_SQUARED;
    if (forwardValid) this.forwardCandidate.normalize();

    this.rightDerivedForwardCandidate
      .copy(LOCAL_RIGHT)
      .applyQuaternion(this.temporaryQuaternion);
    const chassisRightVerticality = Math.abs(this.rightDerivedForwardCandidate.y);
    this.rightDerivedForwardCandidate.y = 0;
    const rightLengthSquared = this.rightDerivedForwardCandidate.lengthSq();
    const rightValid = Number.isFinite(rightLengthSquared)
      && rightLengthSquared > HEADING_PROJECTION_MINIMUM_LENGTH_SQUARED;
    if (rightValid) {
      this.rightDerivedForwardCandidate
        .normalize()
        .cross(WORLD_UP)
        .normalize();
    }

    // Only freeze the heading when neither axis can be projected, which is the
    // genuinely ambiguous nose-straight-up-and-rolled case.
    if (!forwardValid && !rightValid) {
      this.headingLockedForTilt = true;
      this.forward.copy(this.lastForward);
      return;
    }
    this.headingLockedForTilt = false;

    const preferForward = forwardValid
      && (!rightValid || chassisForwardVerticality <= chassisRightVerticality);
    if (preferForward) {
      this.forward.copy(this.forwardCandidate);
      return;
    }

    // The right-derived heading is only defined up to a half turn, so align it
    // with the previous heading instead of letting it jump sides mid-flip.
    this.forward.copy(this.rightDerivedForwardCandidate);
    if (this.forward.dot(this.lastForward) < 0) this.forward.negate();
  }

  private updateBallCamera(
    camera: THREE.PerspectiveCamera,
    deltaSeconds: number,
    rebase: boolean,
  ): void {
    const config = this.configurationValue.ball;
    this.targetPosition
      .copy(this.carPosition)
      .addScaledVector(
        this.forward,
        -(config.distance + FLIP_CAMERA_PULLBACK_DISTANCE * this.flipPullbackAlpha),
      );
    this.targetPosition.y += config.height;
    this.targetLookAt.copy(this.ballPosition);
    clampVectorComponents(this.targetPosition);
    clampVectorComponents(this.targetLookAt);

    const springConfig = this.configurationValue.car;
    if (rebase) {
      camera.position.copy(this.targetPosition);
      this.smoothedLookAt.copy(this.targetLookAt);
      this.positionVelocity.set(0, 0, 0);
      this.lookVelocity.set(0, 0, 0);
    } else {
      springVector(
        camera.position,
        this.positionVelocity,
        this.targetPosition,
        springConfig.stiffness,
        springConfig.damping,
        deltaSeconds,
      );
      springVector(
        this.smoothedLookAt,
        this.lookVelocity,
        this.targetLookAt,
        springConfig.stiffness,
        springConfig.damping,
        deltaSeconds,
      );
    }

    this.clampPositionAroundCar(camera.position, config.distance);
    clampVectorComponents(this.smoothedLookAt);
    this.orientCamera(camera, this.smoothedLookAt);
    this.updateFieldOfView(
      camera,
      config.fieldOfViewDegrees,
      CAMERA_CONFIGURATION_RANGES.ball.fieldOfViewDegrees,
      rebase,
      VISUAL.CAMERA.FOV_RESPONSE,
      deltaSeconds,
    );
  }

  private updateCarCamera(
    camera: THREE.PerspectiveCamera,
    deltaSeconds: number,
    rebase: boolean,
  ): void {
    const config = this.configurationValue.car;
    this.targetPosition
      .copy(this.carPosition)
      .addScaledVector(
        this.forward,
        -(config.distance + FLIP_CAMERA_PULLBACK_DISTANCE * this.flipPullbackAlpha),
      );
    this.targetPosition.y += config.height;
    this.targetLookAt
      .copy(this.carPosition)
      .addScaledVector(this.forward, config.lookAhead);
    clampVectorComponents(this.targetPosition);
    clampVectorComponents(this.targetLookAt);

    if (rebase) {
      camera.position.copy(this.targetPosition);
      this.smoothedLookAt.copy(this.targetLookAt);
      this.positionVelocity.set(0, 0, 0);
      this.lookVelocity.set(0, 0, 0);
    } else {
      springVector(
        camera.position,
        this.positionVelocity,
        this.targetPosition,
        config.stiffness,
        config.damping,
        deltaSeconds,
      );
      springVector(
        this.smoothedLookAt,
        this.lookVelocity,
        this.targetLookAt,
        config.stiffness,
        config.damping,
        deltaSeconds,
      );
    }

    this.clampPositionAroundCar(camera.position, config.distance);
    clampVectorComponents(this.smoothedLookAt);
    this.orientCamera(camera, this.smoothedLookAt);
    this.updateFieldOfView(
      camera,
      config.fieldOfViewDegrees,
      CAMERA_CONFIGURATION_RANGES.car.fieldOfViewDegrees,
      rebase,
      config.damping,
      deltaSeconds,
    );
  }

  private clampPositionAroundCar(position: THREE.Vector3, configuredDistance: number): void {
    clampVectorComponents(position);
    const offsetX = position.x - this.carPosition.x;
    const offsetZ = position.z - this.carPosition.z;
    const horizontalDistance = Math.hypot(offsetX, offsetZ);
    const maxDistance = Math.max(
      CAMERA_CONFIGURATION_RANGES.ball.distance.max,
      CAMERA_CONFIGURATION_RANGES.ball.lookAhead.max,
      CAMERA_CONFIGURATION_RANGES.car.distance.max,
    );
    if (Number.isFinite(horizontalDistance) && horizontalDistance > maxDistance) {
      const scale = maxDistance / horizontalDistance;
      position.x = this.carPosition.x + offsetX * scale;
      position.z = this.carPosition.z + offsetZ * scale;
    }

    // Reversing drives the car towards its own chase target, so the spring lag
    // subtracts from the follow distance instead of adding to it. Hold a floor.
    const minimumDistance = Number.isFinite(configuredDistance)
      ? Math.max(0, configuredDistance) * VISUAL.CAMERA.MINIMUM_FOLLOW_RATIO
      : 0;
    if (
      minimumDistance > 0
      && Number.isFinite(horizontalDistance)
      && horizontalDistance < minimumDistance
    ) {
      // Push straight out along the direction the camera already sits, so it
      // keeps its side of the car instead of snapping behind the heading. The
      // heading is the only sane fallback when the camera is right on top.
      let directionX = offsetX;
      let directionZ = offsetZ;
      if (horizontalDistance <= VECTOR_EPSILON) {
        directionX = -this.forward.x;
        directionZ = -this.forward.z;
      }
      const length = Math.hypot(directionX, directionZ);
      if (Number.isFinite(length) && length > VECTOR_EPSILON) {
        position.x = this.carPosition.x + (directionX / length) * minimumDistance;
        position.z = this.carPosition.z + (directionZ / length) * minimumDistance;
      }
    }

    const maxHeight = Math.max(
      CAMERA_CONFIGURATION_RANGES.ball.height.max,
      CAMERA_CONFIGURATION_RANGES.car.height.max,
    );
    position.y = THREE.MathUtils.clamp(
      position.y,
      this.carPosition.y,
      this.carPosition.y + maxHeight,
    );
    clampVectorComponents(position);
  }

  private orientCamera(camera: THREE.PerspectiveCamera, lookAt: THREE.Vector3): void {
    this.temporaryVector.copy(lookAt);
    clampVectorComponents(this.temporaryVector);
    if (this.temporaryVector.distanceToSquared(camera.position) <= VECTOR_EPSILON_SQUARED) {
      this.temporaryVector.copy(camera.position).add(this.forward);
    }
    camera.lookAt(this.temporaryVector);
    if (!finiteQuaternion(camera.quaternion)) {
      camera.quaternion.set(0, 0, 0, 1);
    } else {
      camera.quaternion.normalize();
    }
  }

  private updateFieldOfView(
    camera: THREE.PerspectiveCamera,
    target: number,
    range: FiniteRange,
    rebase: boolean,
    response: number,
    deltaSeconds: number,
  ): void {
    const current = Number.isFinite(camera.fov) ? camera.fov : target;
    const next = rebase
      ? target
      : THREE.MathUtils.lerp(current, target, dampingAlpha(response, deltaSeconds));
    camera.fov = THREE.MathUtils.clamp(
      Number.isFinite(next) ? next : target,
      range.min,
      range.max,
    );
    camera.updateProjectionMatrix();
  }

  private updateOrbit(
    camera: THREE.PerspectiveCamera,
    elapsedSeconds: number,
    deltaSeconds: number,
  ): void {
    const angle = elapsedSeconds * VISUAL.CAMERA.ORBIT_RATE;
    camera.position.set(
      Math.sin(angle) * VISUAL.CAMERA.ORBIT_RADIUS_X,
      VISUAL.CAMERA.ORBIT_HEIGHT,
      Math.cos(angle) * VISUAL.CAMERA.ORBIT_RADIUS_Z,
    );
    this.targetLookAt.set(0, VISUAL.CAMERA.ORBIT_LOOK_HEIGHT, 0);
    this.orientCamera(camera, this.targetLookAt);
    const orbitFovAlpha = dampingAlpha(VISUAL.CAMERA.FOV_RESPONSE, deltaSeconds);
    camera.fov = THREE.MathUtils.lerp(
      Number.isFinite(camera.fov) ? camera.fov : VISUAL.CAMERA.FOV_MIN,
      VISUAL.CAMERA.FOV_MIN,
      orbitFovAlpha,
    );
    camera.updateProjectionMatrix();
  }

  private resetHistory(): void {
    this.historyInitialized = false;
    this.historyNeedsRebase = true;
    this.positionVelocity.set(0, 0, 0);
    this.lookVelocity.set(0, 0, 0);
  }
}

const defaultController = new CameraController();

/** Switch to presentation-only lobby orbit. */
export function setOrbitMode(): void {
  defaultController.setOrbitMode();
}

/** Prepare a room session that defaults to Ball Camera before first Active Play. */
export function beginGameplayCameraSession(cameraToggleSequence = 0): void {
  defaultController.beginGameplaySession(cameraToggleSequence);
}

/** Compatibility alias used by the existing visual regression harness. */
export function setFollowMode(): void {
  defaultController.setGameplayMode('car');
}

export function getCameraMode(): CameraMode {
  return defaultController.mode;
}

export function getCameraConfiguration(): CameraConfiguration {
  return defaultController.configuration;
}

export function applyCameraConfiguration(candidate: unknown): boolean {
  return defaultController.applyConfiguration(candidate);
}

export function applyCameraTuningSnapshot(
  snapshot: Pick<TuningRegistrySnapshot, 'get'>,
): boolean {
  return defaultController.applyTuningSnapshot(snapshot);
}

/** Update the singleton presentation camera from already-interpolated entity meshes. */
export function updateCamera(
  camera: THREE.PerspectiveCamera,
  carMesh: THREE.Object3D | null,
  elapsedSeconds: number,
  deltaSeconds: number,
  options: CameraUpdateOptions = {},
): void {
  defaultController.update({
    camera,
    localCar: carMesh,
    ball: options.ball ?? null,
    elapsedSeconds,
    deltaSeconds,
    activePlay: options.activePlay ?? true,
    cameraToggleSequence: options.cameraToggleSequence
      ?? defaultController.consumedCameraToggleSequence,
    presentedKickoffEpoch: options.presentedKickoffEpoch ?? null,
  });
}
