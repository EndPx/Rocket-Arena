import * as THREE from 'three';
import { VISUAL } from '@rocket-arena/shared';
import { getBallMesh, getCarMeshes, getLocalState } from '../networking/state-listener.js';
import { getCarVisualRig, type CarVisualRig } from './car.js';
import { getBallVisualRig, type BallVisualRig } from './ball.js';

export interface SyncedPlayerVisualState {
  vx: number;
  vy: number;
  vz: number;
  boost: number;
}

export interface SyncedBallVisualState {
  vx: number;
  vy: number;
  vz: number;
}

const localForward = new THREE.Vector3(0, 0, 1);
const worldForward = new THREE.Vector3();
const horizontalVelocity = new THREE.Vector3();
const ballVelocity = new THREE.Vector3();
const ballSpinAxis = new THREE.Vector3();
const trailDirection = new THREE.Vector3();
const trailRotation = new THREE.Quaternion();
const trailLocalRotation = new THREE.Quaternion();
const coneAxis = new THREE.Vector3(0, 1, 0);
const markerOffset = new THREE.Vector3();
const ballInverseRotation = new THREE.Quaternion();

/** The resolved arena floor surface sits exactly on the world origin plane. */
const ARENA_FLOOR_Y = 0;

function dampingAlpha(response: number, deltaSeconds: number): number {
  return 1 - Math.exp(-Math.max(0, response) * Math.max(0, deltaSeconds));
}

export function inferSteerPresentation(
  forward: THREE.Vector3,
  velocity: THREE.Vector3,
): number {
  const horizontalSpeed = Math.hypot(velocity.x, velocity.z);
  if (horizontalSpeed < VISUAL.MOTION.STEER_VELOCITY_THRESHOLD) return 0;

  const velocityX = velocity.x / horizontalSpeed;
  const velocityZ = velocity.z / horizontalSpeed;
  const lateralSignal = forward.z * velocityX - forward.x * velocityZ;
  return THREE.MathUtils.clamp(lateralSignal * 2.2, -1, 1);
}

function setEffectOpacity(mesh: THREE.Mesh, opacity: number): void {
  if (mesh.material instanceof THREE.MeshBasicMaterial) {
    mesh.material.opacity = opacity;
  }
}

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

/**
 * Advance one rig from accepted presentation values only. Every result is
 * finite, bounded, and frame-rate independent, and nothing here moves a car or
 * mutates accepted state.
 */
function advanceRig(
  rig: CarVisualRig,
  orientation: THREE.Quaternion,
  player: SyncedPlayerVisualState,
  deltaSeconds: number,
  elapsedSeconds: number,
  phaseOffset: number,
): void {
  if (rig.isDisposed) return;

  const step = Math.max(0, finiteOrZero(deltaSeconds));
  const now = finiteOrZero(elapsedSeconds);
  const motion = rig.motion;

  horizontalVelocity.set(finiteOrZero(player.vx), 0, finiteOrZero(player.vz));
  const horizontalSpeed = horizontalVelocity.length();
  worldForward.copy(localForward).applyQuaternion(orientation);
  worldForward.y = 0;
  if (worldForward.lengthSq() > 0.0001) worldForward.normalize();

  const signedForwardSpeed = horizontalVelocity.dot(worldForward);
  motion.wheelSpeed = THREE.MathUtils.lerp(
    motion.wheelSpeed,
    signedForwardSpeed,
    dampingAlpha(VISUAL.MOTION.WHEEL_SPIN_RESPONSE, step),
  );

  const wheelDelta = rig.wheelRadius > 0
    ? -(motion.wheelSpeed / rig.wheelRadius) * step
    : 0;
  for (const wheel of rig.wheelSpins) {
    wheel.rotation.x = (wheel.rotation.x + wheelDelta) % (Math.PI * 2);
  }

  const steerTarget = inferSteerPresentation(worldForward, horizontalVelocity)
    * VISUAL.MOTION.STEER_MAX_ANGLE;
  const steerAlpha = dampingAlpha(VISUAL.MOTION.STEER_RESPONSE, step);
  for (const steeringPivot of rig.frontWheelSteers) {
    steeringPivot.rotation.y = THREE.MathUtils.lerp(
      steeringPivot.rotation.y,
      steerTarget,
      steerAlpha,
    );
  }

  const boost = finiteOrZero(player.boost);
  if (
    motion.hasBoostReference
    && motion.lastBoost - boost >= VISUAL.MOTION.BOOST_DROP_THRESHOLD
    && horizontalSpeed >= VISUAL.MOTION.BOOST_MIN_SPEED
  ) {
    motion.boostActiveUntil = now + VISUAL.MOTION.BOOST_HOLD_SECONDS;
  }
  motion.lastBoost = boost;
  motion.hasBoostReference = true;

  const boostTarget = now < motion.boostActiveUntil ? 1 : 0;
  motion.boostBlend = THREE.MathUtils.clamp(
    THREE.MathUtils.lerp(
      motion.boostBlend,
      boostTarget,
      dampingAlpha(VISUAL.MOTION.BOOST_FADE_RESPONSE, step),
    ),
    0,
    1,
  );

  const boostBlend = motion.boostBlend;
  const visible = boostBlend > 0.015;
  const flicker = 1 + Math.sin(
    now * VISUAL.MOTION.FLAME_FLICKER_RATE + phaseOffset,
  ) * VISUAL.MOTION.FLAME_FLICKER_AMOUNT;
  const speedLength = 0.58 + horizontalSpeed * VISUAL.MOTION.TRAIL_SPEED_SCALE;

  for (const flame of rig.boostFlames) {
    flame.visible = visible;
    flame.scale.set(
      0.82 + boostBlend * 0.18,
      Math.max(0.08, boostBlend * flicker),
      0.82 + boostBlend * 0.18,
    );
    setEffectOpacity(flame, 0.82 * boostBlend);
  }
  for (const trail of rig.boostTrails) {
    trail.visible = visible;
    trail.scale.set(
      0.72 + boostBlend * 0.22,
      Math.max(0.08, boostBlend * speedLength),
      0.72 + boostBlend * 0.22,
    );
    setEffectOpacity(trail, VISUAL.MOTION.TRAIL_OPACITY * boostBlend);
  }
}

/** Update one car's presentation from synchronized state; never changes physics. */
export function updateCarVisualRig(
  car: THREE.Group,
  player: SyncedPlayerVisualState,
  deltaSeconds: number,
  elapsedSeconds: number,
  phaseOffset = 0,
): void {
  const rig = getCarVisualRig(car);
  if (!rig) return;
  advanceRig(rig, car.quaternion, player, deltaSeconds, elapsedSeconds, phaseOffset);
}

/**
 * Advance the ball rig from accepted presentation values only. Spin, pulse,
 * trail, and proximity glow are finite and frame-rate bounded, and none of them
 * infers a goal, a contact, or any score authority.
 */
export function updateBallVisualRig(
  ball: THREE.Group,
  velocity: SyncedBallVisualState,
  nearestCarDistance: number | null,
  deltaSeconds: number,
): void {
  const rig: BallVisualRig | null = getBallVisualRig(ball);
  if (!rig || rig.isDisposed) return;

  const tuning = VISUAL.BALL_MOTION;
  const step = Math.max(0, finiteOrZero(deltaSeconds));
  const motion = rig.motion;

  ballVelocity.set(
    finiteOrZero(velocity.vx),
    finiteOrZero(velocity.vy),
    finiteOrZero(velocity.vz),
  );
  const instantSpeed = ballVelocity.length();
  motion.speed = THREE.MathUtils.lerp(
    motion.speed,
    instantSpeed,
    dampingAlpha(tuning.SPEED_RESPONSE, step),
  );
  const speedRatio = THREE.MathUtils.clamp(motion.speed / tuning.SPEED_FOR_MAX, 0, 1);

  // Presentation spin lives on an inner gyro so it never contradicts the
  // authoritative shell orientation applied by the reconciler.
  if (instantSpeed > 1e-3) {
    ballSpinAxis.copy(ballVelocity).normalize().cross(coneAxis);
    if (ballSpinAxis.lengthSq() < 1e-6) ballSpinAxis.set(1, 0, 0);
    else ballSpinAxis.normalize();
  } else if (ballSpinAxis.lengthSq() < 1e-6) {
    ballSpinAxis.set(1, 0, 0);
  }
  motion.gyroAngle = (motion.gyroAngle + speedRatio * tuning.GYRO_MAX_RATE * step) % (Math.PI * 2);
  rig.gyro.setRotationFromAxisAngle(ballSpinAxis, motion.gyroAngle);

  motion.pulsePhase = (motion.pulsePhase + tuning.PULSE_RATE * step) % (Math.PI * 2);
  const pulse = 1 + Math.sin(motion.pulsePhase) * tuning.PULSE_AMOUNT * (0.35 + speedRatio * 0.65);
  const coreMaterial = rig.core.material;
  if (coreMaterial instanceof THREE.MeshStandardMaterial) {
    coreMaterial.emissiveIntensity = VISUAL.BALL.CORE_GLOW * pulse;
  }
  const nodeMaterial = rig.nodes.material;
  if (nodeMaterial instanceof THREE.MeshStandardMaterial) {
    nodeMaterial.emissiveIntensity = VISUAL.BALL.NODE_GLOW * pulse;
  }

  const trailTarget = motion.speed > tuning.TRAIL_MIN_SPEED ? speedRatio : 0;
  motion.trailBlend = THREE.MathUtils.clamp(
    THREE.MathUtils.lerp(motion.trailBlend, trailTarget, dampingAlpha(tuning.TRAIL_RESPONSE, step)),
    0,
    1,
  );
  const trailVisible = motion.trailBlend > 0.02 && instantSpeed > 1e-3;
  rig.trail.visible = trailVisible;
  if (trailVisible) {
    // The root carries the authoritative rotation, so the trail is aligned in
    // world space and then expressed back in the root's local frame.
    trailDirection.copy(ballVelocity).normalize().negate();
    trailRotation.setFromUnitVectors(coneAxis, trailDirection);
    trailLocalRotation.copy(ball.quaternion).invert().multiply(trailRotation);
    rig.trail.quaternion.copy(trailLocalRotation);
    const length = Math.max(0.05, motion.trailBlend * tuning.TRAIL_MAX_LENGTH_SCALE);
    rig.trail.scale.set(0.55 + motion.trailBlend * 0.35, length, 0.55 + motion.trailBlend * 0.35);
    // Seat the cone so its base meets the ball and its tip trails behind.
    rig.trail.position.copy(coneAxis)
      .multiplyScalar(rig.trailHalfLength * length)
      .applyQuaternion(trailLocalRotation);
    const trailMaterial = rig.trail.material;
    if (trailMaterial instanceof THREE.MeshBasicMaterial) {
      trailMaterial.opacity = tuning.TRAIL_MAX_OPACITY * motion.trailBlend;
    }
  }

  const proximityTarget = nearestCarDistance === null || !Number.isFinite(nearestCarDistance)
    ? 0
    : THREE.MathUtils.clamp(
      1 - (nearestCarDistance - rig.radius) / tuning.PROXIMITY_RADIUS,
      0,
      1,
    );
  motion.proximityBlend = THREE.MathUtils.clamp(
    THREE.MathUtils.lerp(
      motion.proximityBlend,
      proximityTarget,
      dampingAlpha(tuning.PROXIMITY_RESPONSE, step),
    ),
    0,
    1,
  );
  const glowVisible = motion.proximityBlend > 0.02;
  rig.glow.visible = glowVisible;
  const glowMaterial = rig.glow.material;
  if (glowMaterial instanceof THREE.MeshBasicMaterial) {
    glowMaterial.opacity = tuning.PROXIMITY_MAX_OPACITY * motion.proximityBlend;
  }

  updateBallGroundMarker(rig, ball, tuning);
}

/**
 * Project the ground marker onto the floor beneath the ball.
 *
 * The marker belongs to the ball rig for ownership, but the rig root carries the
 * authoritative ball rotation and altitude, so the marker is placed by undoing
 * both: it is offset straight down in world space and counter-rotated back to
 * flat. It grows and fades with altitude so the ball's height reads at a glance.
 */
function updateBallGroundMarker(
  rig: BallVisualRig,
  ball: THREE.Group,
  tuning: typeof VISUAL.BALL_MOTION,
): void {
  const marker = rig.groundMarker;
  const height = ball.position.y - ARENA_FLOOR_Y;
  if (!Number.isFinite(height)) {
    marker.visible = false;
    return;
  }

  // Below the floor there is nothing meaningful to project onto.
  if (height < -rig.radius) {
    marker.visible = false;
    rig.motion.altitudeBlend = 0;
    return;
  }

  const altitude = Math.max(0, height - rig.radius);
  const altitudeBlend = THREE.MathUtils.clamp(
    altitude / Math.max(tuning.MARKER_FULL_FADE_HEIGHT, 1e-3),
    0,
    1,
  );
  rig.motion.altitudeBlend = altitudeBlend;

  const dropDistance = Math.max(0, height - tuning.MARKER_FLOOR_CLEARANCE);
  markerOffset.set(0, -dropDistance, 0);
  ballInverseRotation.copy(ball.quaternion).invert();
  marker.position.copy(markerOffset).applyQuaternion(ballInverseRotation);
  marker.quaternion.copy(ballInverseRotation);

  // The ring is authored at the ball radius, so it must always be scaled past
  // one. At exactly one it hides inside the ball's own silhouette and only
  // peeks out at steep camera angles.
  const scale = THREE.MathUtils.lerp(
    tuning.MARKER_GROUNDED_SCALE,
    tuning.MARKER_LIFTED_SCALE,
    altitudeBlend,
  );
  marker.scale.setScalar(scale);

  const opacity = THREE.MathUtils.lerp(
    tuning.MARKER_GROUNDED_OPACITY,
    tuning.MARKER_LIFTED_OPACITY,
    altitudeBlend,
  );
  for (const child of marker.children) {
    if (!(child instanceof THREE.Mesh)) continue;
    const material = child.material;
    if (material instanceof THREE.MeshBasicMaterial) material.opacity = opacity;
  }
  marker.visible = opacity > 0.01;
}

/** Advance all car and ball effects from the latest accepted snapshot projection. */
export function updateEntityEffects(deltaSeconds: number, elapsedSeconds: number): void {
  const state = getLocalState();
  if (!state) return;

  let index = 0;
  for (const [sessionId, car] of getCarMeshes()) {
    const player = state.players[sessionId];
    if (player) {
      updateCarVisualRig(car, player, deltaSeconds, elapsedSeconds, index * 1.37);
    }
    index += 1;
  }

  const ball = getBallMesh();
  if (!ball) return;
  updateBallVisualRig(ball, state.ball, nearestCarDistanceToBall(ball), deltaSeconds);
}

/**
 * Distance from the ball to the closest presented car, or null when no car is
 * presented. This is a proximity reading of accepted transforms only; it makes
 * no claim that a contact occurred.
 */
function nearestCarDistanceToBall(ball: THREE.Group): number | null {
  let nearest: number | null = null;
  for (const car of getCarMeshes().values()) {
    const distance = car.position.distanceTo(ball.position);
    if (!Number.isFinite(distance)) continue;
    if (nearest === null || distance < nearest) nearest = distance;
  }
  return nearest;
}

/**
 * Dispose one car's presentation resources. Rig-backed roots release their
 * per-car effect materials and one shared reference; legacy roots fall back to
 * releasing the effect materials they expose.
 */
export function disposeCarVisualEffects(car: THREE.Group): void {
  const rig = getCarVisualRig(car);
  if (rig) {
    rig.dispose();
    return;
  }

  const legacy = car.userData.visualRig as
    | Pick<CarVisualRig, 'boostFlames' | 'boostTrails'>
    | undefined;
  if (!legacy) return;
  for (const effect of [...legacy.boostFlames, ...legacy.boostTrails]) {
    const materials = Array.isArray(effect.material) ? effect.material : [effect.material];
    materials.forEach((material) => material.dispose());
  }
}
