import * as THREE from 'three';
import { VISUAL } from '@rocket-arena/shared';

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const LOCAL_FORWARD = new THREE.Vector3(0, 0, 1);
const projectedForward = new THREE.Vector3();
const smoothedForward = new THREE.Vector3(0, 0, 1);
const targetPosition = new THREE.Vector3();
const targetLookAt = new THREE.Vector3();
const smoothedLookAt = new THREE.Vector3();
const lastCarPosition = new THREE.Vector3();

let mode: 'orbit' | 'follow' = 'orbit';
let followInitialized = false;

export function dampingAlpha(response: number, deltaSeconds: number): number {
  return 1 - Math.exp(-Math.max(0, response) * Math.max(0, deltaSeconds));
}

/** Switch camera to orbit mode for lobby and waiting screens. */
export function setOrbitMode(): void {
  mode = 'orbit';
  followInitialized = false;
}

/** Switch camera to stabilized follow mode for active play. */
export function setFollowMode(): void {
  mode = 'follow';
  followInitialized = false;
}

export function getCameraMode(): 'orbit' | 'follow' {
  return mode;
}

/**
 * Update the camera from synchronized car transform and velocity only.
 * Roll and pitch are deliberately removed from the follow heading to prevent
 * camera sickness while the car jumps, lands, or tumbles.
 */
export function updateCamera(
  camera: THREE.PerspectiveCamera,
  carMesh: THREE.Group | null,
  elapsedSeconds: number,
  deltaSeconds: number,
): void {
  const delta = Math.min(Math.max(deltaSeconds, 0), 0.1);
  camera.up.copy(WORLD_UP);

  if (mode === 'orbit' || !carMesh) {
    const angle = elapsedSeconds * VISUAL.CAMERA.ORBIT_RATE;
    camera.position.set(
      Math.sin(angle) * VISUAL.CAMERA.ORBIT_RADIUS_X,
      VISUAL.CAMERA.ORBIT_HEIGHT,
      Math.cos(angle) * VISUAL.CAMERA.ORBIT_RADIUS_Z,
    );
    targetLookAt.set(0, VISUAL.CAMERA.ORBIT_LOOK_HEIGHT, 0);
    camera.lookAt(targetLookAt);
    const orbitFovAlpha = dampingAlpha(VISUAL.CAMERA.FOV_RESPONSE, delta);
    camera.fov = THREE.MathUtils.lerp(camera.fov, VISUAL.CAMERA.FOV_MIN, orbitFovAlpha);
    camera.updateProjectionMatrix();
    followInitialized = false;
    return;
  }

  const carPosition = carMesh.position;
  projectedForward.copy(LOCAL_FORWARD).applyQuaternion(carMesh.quaternion);
  projectedForward.y = 0;
  if (projectedForward.lengthSq() < 0.0001) {
    projectedForward.copy(smoothedForward);
  } else {
    projectedForward.normalize();
  }

  const speed = typeof carMesh.userData.syncedSpeed === 'number'
    ? carMesh.userData.syncedSpeed
    : 0;
  const speedRatio = THREE.MathUtils.clamp(speed / VISUAL.CAMERA.SPEED_FOR_MAX, 0, 1);
  const distance = THREE.MathUtils.lerp(
    VISUAL.CAMERA.FOLLOW_DISTANCE_MIN,
    VISUAL.CAMERA.FOLLOW_DISTANCE_MAX,
    speedRatio,
  );
  const height = THREE.MathUtils.lerp(
    VISUAL.CAMERA.HEIGHT_MIN,
    VISUAL.CAMERA.HEIGHT_MAX,
    speedRatio,
  );
  const lookAhead = THREE.MathUtils.lerp(
    VISUAL.CAMERA.LOOK_AHEAD_MIN,
    VISUAL.CAMERA.LOOK_AHEAD_MAX,
    speedRatio,
  );

  const teleported = followInitialized
    && lastCarPosition.distanceTo(carPosition) > VISUAL.CAMERA.TELEPORT_DISTANCE;

  if (!followInitialized || teleported) {
    smoothedForward.copy(projectedForward);
  } else {
    smoothedForward
      .lerp(projectedForward, dampingAlpha(VISUAL.CAMERA.YAW_RESPONSE, delta))
      .normalize();
  }

  targetPosition
    .copy(carPosition)
    .addScaledVector(smoothedForward, -distance);
  targetPosition.y += height;

  targetLookAt
    .copy(carPosition)
    .addScaledVector(smoothedForward, lookAhead);
  targetLookAt.y += 0.55;

  if (!followInitialized || teleported) {
    camera.position.copy(targetPosition);
    smoothedLookAt.copy(targetLookAt);
    followInitialized = true;
  } else {
    camera.position.lerp(
      targetPosition,
      dampingAlpha(VISUAL.CAMERA.POSITION_RESPONSE, delta),
    );
    smoothedLookAt.lerp(
      targetLookAt,
      dampingAlpha(VISUAL.CAMERA.LOOK_RESPONSE, delta),
    );
  }

  lastCarPosition.copy(carPosition);
  camera.lookAt(smoothedLookAt);

  const targetFov = THREE.MathUtils.lerp(
    VISUAL.CAMERA.FOV_MIN,
    VISUAL.CAMERA.FOV_MAX,
    speedRatio,
  );
  camera.fov = THREE.MathUtils.lerp(
    camera.fov,
    targetFov,
    dampingAlpha(VISUAL.CAMERA.FOV_RESPONSE, delta),
  );
  camera.updateProjectionMatrix();
}
