import * as THREE from 'three';
import { CAMERA } from '@rocket-arena/shared';

const targetPosition = new THREE.Vector3();
const targetLookAt = new THREE.Vector3();

let mode: 'orbit' | 'follow' = 'orbit';

/** Switch camera to orbit mode (lobby/waiting). */
export function setOrbitMode(): void {
  mode = 'orbit';
}

/** Switch camera to follow mode (in-game). */
export function setFollowMode(): void {
  mode = 'follow';
}

/** Get current camera mode. */
export function getCameraMode(): 'orbit' | 'follow' {
  return mode;
}

/**
 * Update camera. In orbit mode, slowly orbits the arena center.
 * In follow mode, follows behind the local player's car.
 *
 * @param camera - The Three.js camera
 * @param carMesh - The local player's car mesh group (or null if not yet available)
 * @param time - Elapsed time in seconds (performance.now() / 1000)
 */
export function updateCamera(camera: THREE.PerspectiveCamera, carMesh: THREE.Group | null, time: number): void {
  if (mode === 'orbit' || !carMesh) {
    // Orbit around center of arena
    const radius = 45;
    const speed = 0.3;
    const angle = time * speed;
    camera.position.set(
      Math.sin(angle) * radius,
      15,
      Math.cos(angle) * radius
    );
    camera.lookAt(0, 0, 0);
    return;
  }

  // Follow mode — behind the car
  const carPos = carMesh.position;
  const carQuat = carMesh.quaternion;

  // Compute "behind" direction from car's rotation
  const behindOffset = new THREE.Vector3(0, CAMERA.HEIGHT_OFFSET, -CAMERA.FOLLOW_DISTANCE);
  behindOffset.applyQuaternion(carQuat);
  targetPosition.copy(carPos).add(behindOffset);

  // Look-at point: slightly ahead of car
  const lookAheadOffset = new THREE.Vector3(0, 1, CAMERA.LOOK_AHEAD_DISTANCE);
  lookAheadOffset.applyQuaternion(carQuat);
  targetLookAt.copy(carPos).add(lookAheadOffset);

  // Smooth follow with lerp
  camera.position.lerp(targetPosition, CAMERA.LERP_SPEED);

  // Look at the smoothed target
  camera.lookAt(targetLookAt);
}
