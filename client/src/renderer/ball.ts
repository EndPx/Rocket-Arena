import * as THREE from 'three';
import { BALL } from '@rocket-arena/shared';

/**
 * Create a procedural ball mesh (sphere with slight emissive glow).
 */
export function createBallMesh(): THREE.Mesh {
  const geo = new THREE.SphereGeometry(BALL.RADIUS, 24, 24);
  const mat = new THREE.MeshStandardMaterial({
    color: 0xeeeeee,
    emissive: 0x444444,
    emissiveIntensity: 0.2,
    roughness: 0.3,
    metalness: 0.1,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  return mesh;
}
