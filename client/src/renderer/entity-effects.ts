import * as THREE from 'three';
import { CAR, VISUAL } from '@rocket-arena/shared';
import { getCarMeshes, getLocalState } from '../networking/state-listener.js';
import type { CarVisualRig } from './car.js';

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

/** Update one car's presentation from synchronized state; never changes physics. */
export function updateCarVisualRig(
  car: THREE.Group,
  player: SyncedPlayerVisualState,
  deltaSeconds: number,
  elapsedSeconds: number,
  phaseOffset = 0,
): void {
  const rig = car.userData.visualRig as CarVisualRig | undefined;
  if (!rig) return;

  horizontalVelocity.set(player.vx, 0, player.vz);
  const horizontalSpeed = horizontalVelocity.length();
  worldForward.copy(localForward).applyQuaternion(car.quaternion);
  worldForward.y = 0;
  if (worldForward.lengthSq() > 0.0001) worldForward.normalize();

  const signedForwardSpeed = horizontalVelocity.dot(worldForward);
  const wheelSpeedAlpha = dampingAlpha(VISUAL.MOTION.WHEEL_SPIN_RESPONSE, deltaSeconds);
  const previousWheelSpeed = typeof car.userData.visualWheelSpeed === 'number'
    ? car.userData.visualWheelSpeed
    : signedForwardSpeed;
  const visualWheelSpeed = THREE.MathUtils.lerp(
    previousWheelSpeed,
    signedForwardSpeed,
    wheelSpeedAlpha,
  );
  car.userData.visualWheelSpeed = visualWheelSpeed;

  const wheelDelta = rig.wheelRadius > 0
    ? -(visualWheelSpeed / rig.wheelRadius) * deltaSeconds
    : 0;
  for (const wheel of rig.wheelSpins) {
    wheel.rotation.x += wheelDelta;
  }

  const steerTarget = inferSteerPresentation(worldForward, horizontalVelocity)
    * VISUAL.MOTION.STEER_MAX_ANGLE;
  const steerAlpha = dampingAlpha(VISUAL.MOTION.STEER_RESPONSE, deltaSeconds);
  for (const steeringPivot of rig.frontWheelSteers) {
    steeringPivot.rotation.y = THREE.MathUtils.lerp(
      steeringPivot.rotation.y,
      steerTarget,
      steerAlpha,
    );
  }

  const previousBoost = typeof car.userData.lastBoost === 'number'
    ? car.userData.lastBoost
    : player.boost;
  if (
    previousBoost - player.boost >= VISUAL.MOTION.BOOST_DROP_THRESHOLD
    && horizontalSpeed >= VISUAL.MOTION.BOOST_MIN_SPEED
  ) {
    car.userData.boostActiveUntil = elapsedSeconds + VISUAL.MOTION.BOOST_HOLD_SECONDS;
  }
  car.userData.lastBoost = player.boost;

  const boostActiveUntil = typeof car.userData.boostActiveUntil === 'number'
    ? car.userData.boostActiveUntil
    : 0;
  const boostTarget = elapsedSeconds < boostActiveUntil ? 1 : 0;
  const previousBlend = typeof car.userData.boostBlend === 'number'
    ? car.userData.boostBlend
    : 0;
  const boostBlend = THREE.MathUtils.lerp(
    previousBlend,
    boostTarget,
    dampingAlpha(VISUAL.MOTION.BOOST_FADE_RESPONSE, deltaSeconds),
  );
  car.userData.boostBlend = boostBlend;

  const visible = boostBlend > 0.015;
  const flicker = 1 + Math.sin(
    elapsedSeconds * VISUAL.MOTION.FLAME_FLICKER_RATE + phaseOffset,
  ) * VISUAL.MOTION.FLAME_FLICKER_AMOUNT;
  const speedLength = 0.58 + horizontalSpeed * VISUAL.MOTION.TRAIL_SPEED_SCALE;

  rig.boostFlames.forEach((flame) => {
    flame.visible = visible;
    flame.scale.set(0.82 + boostBlend * 0.18, Math.max(0.08, boostBlend * flicker), 0.82 + boostBlend * 0.18);
    setEffectOpacity(flame, 0.82 * boostBlend);
  });
  rig.boostTrails.forEach((trail) => {
    trail.visible = visible;
    trail.scale.set(0.72 + boostBlend * 0.22, Math.max(0.08, boostBlend * speedLength), 0.72 + boostBlend * 0.22);
    setEffectOpacity(trail, VISUAL.MOTION.TRAIL_OPACITY * boostBlend);
  });
}

/** Advance all car effects from the latest manual state-sync snapshot. */
export function updateEntityEffects(deltaSeconds: number, elapsedSeconds: number): void {
  const state = getLocalState();
  if (!state) return;

  let index = 0;
  for (const [sessionId, car] of getCarMeshes()) {
    const player = state.players[sessionId];
    if (player) {
      updateCarVisualRig(car, player, deltaSeconds, elapsedSeconds, index * 1.37);
    }
    index++;
  }
}

/** Dispose only per-car effect materials; body materials and geometry are shared. */
export function disposeCarVisualEffects(car: THREE.Group): void {
  const rig = car.userData.visualRig as CarVisualRig | undefined;
  if (!rig) return;
  for (const effect of [...rig.boostFlames, ...rig.boostTrails]) {
    const materials = Array.isArray(effect.material) ? effect.material : [effect.material];
    materials.forEach((material) => material.dispose());
  }
}
