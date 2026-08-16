import * as THREE from 'three';
import { CAMERA } from '@rocket-arena/shared';

const targetPosition = new THREE.Vector3();
const targetLookAt = new THREE.Vector3();

/**
 * Update camera to follow behind the local player's car.
 * Uses lerp for smooth following.
 *
 * @param camera - The Three.js camera
 * @param carMesh - The local player's car mesh group (or null if not yet available)
 */
export function updateCamera(camera: THREE.PerspectiveCamera, carMesh: THREE.Group | null): void {
  if (!carMesh) {
    // Default overview position when no car to follow
    camera.position.lerp(new THREE.Vector3(0, 30, -40), 0.02);
    camera.lookAt(0, 0, 0);
    return;
  }

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
