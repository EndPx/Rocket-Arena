import * as THREE from 'three';
import { type ResolvedArenaGeometry } from '@rocket-arena/shared';
import { ARENA_PRESENTATION_STYLE } from './arena-style.js';

/**
 * Daylight stadium rig: broad sky illumination, one sun shadow caster, one
 * architectural fill, and two geometry-derived goal accents. Visible fixture
 * meshes provide the remaining floodlight hierarchy without extra real lights.
 */
export function createLighting(
  scene: THREE.Scene,
  geometry: ResolvedArenaGeometry,
): THREE.Group {
  const rig = new THREE.Group();
  rig.name = 'stadium-lighting-rig';
  const centerX = (geometry.bounds.min[0] + geometry.bounds.max[0]) / 2;
  const centerY = (geometry.bounds.min[1] + geometry.bounds.max[1]) / 2;
  const centerZ = (geometry.bounds.min[2] + geometry.bounds.max[2]) / 2;
  const halfWidth = (geometry.bounds.max[0] - geometry.bounds.min[0]) / 2;
  const halfLength = (geometry.bounds.max[2] - geometry.bounds.min[2]) / 2;

  const hemisphere = new THREE.HemisphereLight(0xd8f3ff, 0x365244, 1.65);
  hemisphere.name = 'daylight-hemisphere-fill';
  rig.add(hemisphere);

  const key = new THREE.DirectionalLight(0xfff7df, 3.15);
  key.name = 'primary-shadow-key';
  key.position.set(centerX - halfWidth * 1.45, geometry.bounds.max[1] + 24, centerZ - halfLength * 0.7);
  key.target.position.set(centerX, 0, centerZ + halfLength * 0.08);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 2;
  key.shadow.camera.far = Math.max(110, geometry.bounds.max[1] + 76);
  key.shadow.camera.left = -halfWidth - 12;
  key.shadow.camera.right = halfWidth + 12;
  key.shadow.camera.top = halfLength + 14;
  key.shadow.camera.bottom = -halfLength - 14;
  key.shadow.bias = -0.00008;
  key.shadow.normalBias = 0.028;
  rig.add(key, key.target);

  const fill = new THREE.DirectionalLight(0x9ed8ff, 0.72);
  fill.name = 'opposing-architectural-fill';
  fill.position.set(centerX + halfWidth * 1.2, geometry.bounds.max[1] + 7, centerZ + halfLength * 0.5);
  fill.target.position.set(centerX, centerY * 0.35, centerZ);
  rig.add(fill, fill.target);

  for (const goal of geometry.goals) {
    const isBlue = goal.defendingTeam === 'blue';
    const light = new THREE.PointLight(
      isBlue ? ARENA_PRESENTATION_STYLE.blueLight : ARENA_PRESENTATION_STYLE.orangeLight,
      6.2,
      Math.max(goal.opening.width * 3.2, 18),
      2,
    );
    light.name = `${isBlue ? 'blue' : 'orange'}-goal-ambience`;
    light.position.set(
      goal.opening.centerX,
      goal.opening.bottomY + goal.opening.height * 0.55,
      THREE.MathUtils.lerp(goal.goalLineZ, goal.backWallZ, 0.32),
    );
    rig.add(light);
  }

  scene.add(rig);
  return rig;
}
