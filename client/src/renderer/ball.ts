import * as THREE from 'three';
import { BALL } from '@rocket-arena/shared';

/**
 * Create a glowing ball mesh with emissive material.
 */
export function createBallMesh(): THREE.Mesh {
  const geo = new THREE.SphereGeometry(BALL.RADIUS, 32, 32);
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    emissive: 0xccccff,
    emissiveIntensity: 0.4,
    roughness: 0.1,
    metalness: 0.3,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  return mesh;
}
