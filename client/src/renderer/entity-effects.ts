import * as THREE from 'three';
import { VISUAL } from '@rocket-arena/shared';
import { getCarMeshes, getLocalState } from '../networking/state-listener.js';
import { getCarVisualRig, type CarVisualRig } from './car.js';

export interface SyncedPlayerVisualState {
  vx: number;
  vy: number;
  vz: number;
  boost: number;
}

const localForward = new THREE.Vector3(0, 0, 1);
const worldForward = new THREE.Vector3();
const horizontalVelocity = new THREE.Vector3();

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

/** Advance all car effects from the latest accepted snapshot projection. */
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
