import * as THREE from 'three';
import {
  ARENA_HALF_LENGTH_METERS,
  ARENA_HALF_WIDTH_METERS,
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
/**
 * Least speed, in metres per second, that counts as deliberately driving a
 * surface when the chassis nose is too steep to give a ground heading.
 *
 * Below this the car is tumbling, parked, or nose-up in the air, none of which
 * should move the camera off the world-horizontal chase it already had. This is
 * measured from how far the car actually travelled, so a stationary car can
 * never engage it however it is rotated.
 */
const SURFACE_CHASE_MINIMUM_SPEED = 3;
/** How quickly the chase basis swings between world-up and surface-relative. */
const SURFACE_CHASE_RESPONSE = 5;
/**
 * The camera never drops below this world height. Chasing along the travel
 * direction points the offset down the wall while climbing, and without a floor
 * the camera would be placed under the pitch early in a climb.
 */
const CAMERA_MINIMUM_WORLD_HEIGHT = 0.4;
/**
 * Clearance held between the camera and the arena boundary. The camera's side of
 * the car can point straight at a wall, and a camera outside the glass looks at
 * the stands instead of the pitch.
 */
const CAMERA_ARENA_MARGIN = 1.5;
const CAMERA_ARENA_LIMIT_X = ARENA_HALF_WIDTH_METERS - CAMERA_ARENA_MARGIN;
const CAMERA_ARENA_LIMIT_Z = ARENA_HALF_LENGTH_METERS - CAMERA_ARENA_MARGIN;
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
  private readonly chassisForward = new THREE.Vector3(0, 0, 1);
  private readonly chassisRoof = new THREE.Vector3(0, 1, 0);
  private chassisForwardProjectable = true;
  /** Unit direction from the car towards the camera. */
  private readonly chaseBehind = new THREE.Vector3(0, 0, -1);
  /** Unit direction the camera's height offset is taken along. */
  private readonly chaseUp = new THREE.Vector3(0, 1, 0);
  private readonly chaseBehindTarget = new THREE.Vector3(0, 0, -1);
  private readonly chaseUpTarget = new THREE.Vector3(0, 1, 0);
  private readonly motionDirection = new THREE.Vector3();
  /** 0 while the chase is world-up, 1 once it is fully surface-relative. */
  private surfaceChaseAlpha = 0;
  private readonly clampOffset = new THREE.Vector3();
  private readonly clampLateral = new THREE.Vector3();
  private readonly ballFramingOffset = new THREE.Vector3();
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
    // Read before the basis is resolved, because Ball Camera takes which side of
    // the car it sits on from where the ball is.
    const framingBall = this.modeValue === 'ball' ? input.ball : null;
    if (framingBall !== null) copyFinitePosition(this.ballPosition, framingBall.position);
    this.resolveChaseBasis(deltaSeconds, rebase, framingBall !== null);

    if (framingBall !== null) {
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
      // A rotation this broken must not be allowed to hand the camera a
      // surface-relative basis, so leave the chase on its world-up path.
      this.chassisForwardProjectable = true;
      return;
    }

    this.temporaryQuaternion.normalize();

    // Kept in three dimensions as well, because the surface-relative chase needs
    // the axes themselves rather than their ground projections.
    this.chassisForward.copy(LOCAL_FORWARD).applyQuaternion(this.temporaryQuaternion);
    this.chassisRoof.copy(LOCAL_UP).applyQuaternion(this.temporaryQuaternion);
    if (this.chassisForward.lengthSq() > VECTOR_EPSILON_SQUARED) this.chassisForward.normalize();
    if (this.chassisRoof.lengthSq() > VECTOR_EPSILON_SQUARED) this.chassisRoof.normalize();

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
    this.chassisForwardProjectable = forwardValid;

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

  /**
   * Resolve where the camera sits relative to the car, and which way is up for it.
   *
   * On the floor this is the world-horizontal chase heading with a world-up
   * height offset, which is what every framing rule here is written against.
   *
   * Driving up a wall breaks that. The nose points at the sky, so the ground
   * heading is undefined and the projected fallback is derived from the chassis
   * right axis, which sits at a right angle to the direction of travel. The
   * camera was swung out perpendicular to the wall as a result, watching the car
   * from the side instead of following it up.
   *
   * When the nose is that steep and the car is genuinely travelling, the chase
   * follows the travel direction in full three dimensions and takes its height
   * from the chassis roof, which is the axis pointing away from whatever surface
   * the car is on. Gating on measured travel rather than on orientation alone is
   * what keeps a tumbling or parked car on the world-up path.
   *
   * The basis is damped rather than switched, so crossing the ramp onto the wall
   * swings the camera round instead of cutting to the new framing.
   */
  private resolveChaseBasis(
    deltaSeconds: number,
    rebase: boolean,
    ballFraming: boolean,
  ): void {
    this.chaseBehindTarget.copy(this.forward).negate();
    this.chaseUpTarget.copy(WORLD_UP);

    if (ballFraming) {
      // Ball Camera exists to show the car against the ball, so the camera belongs
      // on the far side of the car from the ball rather than behind the car's own
      // heading. The two coincide while driving at the ball, which is why this only
      // showed up when driving away from it: the heading put the camera between the
      // ball and the car, and aiming at the ball then aimed away from the car.
      //
      // Only the plan-view direction is taken, so a ball overhead cannot drop the
      // camera underneath the car and the height offset stays world-up.
      this.ballFramingOffset.copy(this.carPosition).sub(this.ballPosition);
      this.ballFramingOffset.y = 0;
      if (this.ballFramingOffset.lengthSq() > VECTOR_EPSILON_SQUARED) {
        this.chaseBehindTarget.copy(this.ballFramingOffset).normalize();
      }
    }

    const travelled = this.temporaryVector.copy(this.carPosition).sub(this.lastCarPosition);
    const travelledLength = travelled.length();
    const speed = deltaSeconds > 0 && this.historyInitialized && !rebase
      ? travelledLength / deltaSeconds
      : 0;

    // Car Camera only. Ball Camera aims at the ball, so with the car on a wall
    // and the ball out on the pitch the two directions are around 150 degrees
    // apart and no chase position can hold both. Trailing the climb there only
    // trades one view that cannot show the car for another, and drags the camera
    // down to the floor on the way, so Ball Camera keeps its world-up framing.
    if (
      this.modeValue === 'car'
      && !this.chassisForwardProjectable
      && Number.isFinite(speed)
      && speed >= SURFACE_CHASE_MINIMUM_SPEED
      && travelledLength > VECTOR_EPSILON
    ) {
      this.motionDirection.copy(travelled).divideScalar(travelledLength);
      this.chaseBehindTarget.copy(this.motionDirection).negate();
      this.chaseUpTarget.copy(this.chassisRoof);
      this.chaseUpTarget.addScaledVector(
        this.chaseBehindTarget,
        -this.chaseUpTarget.dot(this.chaseBehindTarget),
      );
      if (this.chaseUpTarget.lengthSq() > VECTOR_EPSILON_SQUARED) {
        this.chaseUpTarget.normalize();
      } else {
        // Travelling straight along the roof axis leaves no plane to hold a
        // height offset in, so keep the world-up framing for this frame.
        this.chaseBehindTarget.copy(this.forward).negate();
        this.chaseUpTarget.copy(WORLD_UP);
      }
    }

    if (rebase || !this.historyInitialized) {
      this.chaseBehind.copy(this.chaseBehindTarget);
      this.chaseUp.copy(this.chaseUpTarget);
    } else {
      const alpha = dampingAlpha(SURFACE_CHASE_RESPONSE, deltaSeconds);
      this.chaseBehind.lerp(this.chaseBehindTarget, alpha);
      this.chaseUp.lerp(this.chaseUpTarget, alpha);
    }

    // Damping between two unit vectors can pass through the origin, and the
    // basis has to stay orthonormal for the framing rules to mean anything.
    if (this.chaseBehind.lengthSq() <= VECTOR_EPSILON_SQUARED) {
      this.chaseBehind.copy(this.chaseBehindTarget);
    }
    this.chaseBehind.normalize();
    this.chaseUp.addScaledVector(this.chaseBehind, -this.chaseUp.dot(this.chaseBehind));
    if (this.chaseUp.lengthSq() <= VECTOR_EPSILON_SQUARED) {
      this.chaseUp
        .copy(WORLD_UP)
        .addScaledVector(this.chaseBehind, -WORLD_UP.dot(this.chaseBehind));
      if (this.chaseUp.lengthSq() <= VECTOR_EPSILON_SQUARED) this.chaseUp.set(0, 1, 0);
    }
    this.chaseUp.normalize();

    // How far the basis has tilted off world up, which is also how much the
    // follow offsets need reinterpreting. Derived from the basis rather than
    // damped separately, so it can never disagree with it.
    this.surfaceChaseAlpha = THREE.MathUtils.clamp(
      1 - Math.abs(this.chaseUp.dot(WORLD_UP)),
      0,
      1,
    );
  }

  /**
   * Follow distance for the current basis.
   *
   * The configured distance is measured for open floor, where it points
   * backwards across the pitch and nothing is in the way. Pointed down a wall it
   * drives the camera through the floor within the first few metres of a climb,
   * which pins it at the floor clearance and leaves it sliding along the ground.
   * Surface-relative chases therefore trail by the much shorter height instead,
   * which keeps the camera tucked just below the car and against the wall it is
   * climbing.
   */
  private chaseDistance(distance: number, height: number): number {
    return THREE.MathUtils.lerp(distance, height, this.surfaceChaseAlpha);
  }

  /**
   * Largest offset along the chase direction that keeps the camera inside the
   * arena, never more than what was asked for.
   *
   * Shortening the offset is deliberate rather than clamping the position after
   * the fact. The Ball Camera framing depends on the camera holding its side of
   * the car, and displacing it sideways to get back inside would put the car
   * behind the camera again, which is the failure this path exists to remove. A
   * car pinned against a wall with the ball beyond it therefore gets a close view
   * of itself rather than a view of nothing.
   *
   * A car already outside a bound, which is any car inside a goal, is left alone
   * on that axis so the goal interior keeps the framing it has always had.
   */
  private containedDistance(direction: THREE.Vector3, requested: number): number {
    if (!Number.isFinite(requested) || requested <= 0) return 0;
    let limit = requested;
    const axes: readonly (readonly [number, number, number])[] = [
      [this.carPosition.x, direction.x, CAMERA_ARENA_LIMIT_X],
      [this.carPosition.z, direction.z, CAMERA_ARENA_LIMIT_Z],
    ];
    for (const [origin, component, bound] of axes) {
      if (Math.abs(component) <= VECTOR_EPSILON) continue;
      const available = ((component > 0 ? bound : -bound) - origin) / component;
      if (Number.isFinite(available) && available > 0) limit = Math.min(limit, available);
    }
    return limit;
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
        this.chaseBehind,
        this.containedDistance(
          this.chaseBehind,
          this.chaseDistance(config.distance, config.height)
            + FLIP_CAMERA_PULLBACK_DISTANCE * this.flipPullbackAlpha,
        ),
      )
      .addScaledVector(this.chaseUp, config.height);
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
        this.chaseBehind,
        this.containedDistance(
          this.chaseBehind,
          this.chaseDistance(config.distance, config.height)
            + FLIP_CAMERA_PULLBACK_DISTANCE * this.flipPullbackAlpha,
        ),
      )
      .addScaledVector(this.chaseUp, config.height);
    this.targetLookAt
      .copy(this.carPosition)
      .addScaledVector(this.chaseBehind, -config.lookAhead);
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

  /**
   * Hold the framing rules in the chase basis rather than against world axes.
   *
   * While `chaseUp` is world up these are exactly the horizontal follow clamp and
   * world-up height clamp they have always been. Once the chase goes
   * surface-relative on a wall, the same rules apply around that surface, which
   * is what lets the camera sit behind a climbing car instead of being shoved
   * back up level with it by a world-up floor.
   */
  private clampPositionAroundCar(position: THREE.Vector3, configuredDistance: number): void {
    clampVectorComponents(position);
    const offset = this.clampOffset.copy(position).sub(this.carPosition);
    const alongUp = offset.dot(this.chaseUp);
    const lateral = this.clampLateral.copy(offset).addScaledVector(this.chaseUp, -alongUp);
    const lateralDistance = lateral.length();
    const maxDistance = Math.max(
      CAMERA_CONFIGURATION_RANGES.ball.distance.max,
      CAMERA_CONFIGURATION_RANGES.ball.lookAhead.max,
      CAMERA_CONFIGURATION_RANGES.car.distance.max,
    );
    if (Number.isFinite(lateralDistance) && lateralDistance > maxDistance) {
      lateral.multiplyScalar(maxDistance / lateralDistance);
    }

    // Reversing drives the car towards its own chase target, so the spring lag
    // subtracts from the follow distance instead of adding to it. Hold a floor.
    const minimumDistance = Number.isFinite(configuredDistance)
      ? Math.max(0, configuredDistance) * VISUAL.CAMERA.MINIMUM_FOLLOW_RATIO
      : 0;
    if (
      minimumDistance > 0
      && Number.isFinite(lateralDistance)
      && lateralDistance < minimumDistance
    ) {
      // Push straight out along the direction the camera already sits, so it
      // keeps its side of the car instead of snapping behind the heading. The
      // heading is the only sane fallback when the camera is right on top.
      if (lateralDistance <= VECTOR_EPSILON) {
        lateral
          .copy(this.chaseBehind)
          .addScaledVector(this.chaseUp, -this.chaseBehind.dot(this.chaseUp));
      }
      const length = lateral.length();
      if (Number.isFinite(length) && length > VECTOR_EPSILON) {
        lateral.multiplyScalar(minimumDistance / length);
      }
    }

    const maxHeight = Math.max(
      CAMERA_CONFIGURATION_RANGES.ball.height.max,
      CAMERA_CONFIGURATION_RANGES.car.height.max,
    );
    position
      .copy(this.carPosition)
      .add(lateral)
      .addScaledVector(this.chaseUp, THREE.MathUtils.clamp(alongUp, 0, maxHeight));
    // Chasing along the travel direction points the offset down the wall during a
    // climb, which without this would place the camera under the pitch.
    position.y = Math.max(position.y, CAMERA_MINIMUM_WORLD_HEIGHT);
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
