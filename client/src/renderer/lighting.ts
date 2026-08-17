import * as THREE from 'three';
import { ARENA, VISUAL } from '@rocket-arena/shared';

/**
 * Premium night-stadium lighting with one shadow-casting key, a broad fill,
 * and two non-shadowing goal accents. Floodlight meshes provide the visible
 * fixtures without multiplying expensive real-time lights.
 */
export function createLighting(scene: THREE.Scene): THREE.Group {
  const rig = new THREE.Group();
  rig.name = 'stadium-lighting-rig';

  const hemisphere = new THREE.HemisphereLight(
    0xa7c8dc,
    0x11151b,
    VISUAL.RENDER.HEMISPHERE_INTENSITY,
  );
  hemisphere.name = 'cool-hemisphere-fill';
  rig.add(hemisphere);

  const key = new THREE.DirectionalLight(
    VISUAL.PALETTE.WHITE_LIGHT,
    VISUAL.RENDER.KEY_INTENSITY,
  );
  key.name = 'primary-shadow-key';
  key.position.set(-18, 34, -12);
  key.target.position.set(0, 0, 3);
  key.castShadow = true;
  key.shadow.mapSize.set(
    VISUAL.RENDER.SHADOW_MAP_SIZE,
    VISUAL.RENDER.SHADOW_MAP_SIZE,
  );
  key.shadow.camera.near = 2;
  key.shadow.camera.far = 100;
  key.shadow.camera.left = -30;
  key.shadow.camera.right = 30;
  key.shadow.camera.top = 38;
  key.shadow.camera.bottom = -38;
  key.shadow.bias = VISUAL.RENDER.SHADOW_BIAS;
  key.shadow.normalBias = 0.035;
  rig.add(key, key.target);

  const fill = new THREE.DirectionalLight(0x9bb4c9, VISUAL.RENDER.FILL_INTENSITY);
  fill.name = 'opposing-soft-fill';
  fill.position.set(20, 18, 16);
  fill.target.position.set(0, 2, -4);
  rig.add(fill, fill.target);

  const blueGoal = new THREE.PointLight(
    VISUAL.PALETTE.BLUE_LIGHT,
    VISUAL.RENDER.GOAL_LIGHT_INTENSITY,
    VISUAL.RENDER.GOAL_LIGHT_DISTANCE,
    2,
  );
  blueGoal.name = 'blue-goal-ambience';
  blueGoal.position.set(0, ARENA.GOAL.HEIGHT * 0.58, -ARENA.LENGTH / 2 + 1.2);
  rig.add(blueGoal);

  const orangeGoal = new THREE.PointLight(
    VISUAL.PALETTE.ORANGE_LIGHT,
    VISUAL.RENDER.GOAL_LIGHT_INTENSITY,
    VISUAL.RENDER.GOAL_LIGHT_DISTANCE,
    2,
  );
  orangeGoal.name = 'orange-goal-ambience';
  orangeGoal.position.set(0, ARENA.GOAL.HEIGHT * 0.58, ARENA.LENGTH / 2 - 1.2);
  rig.add(orangeGoal);

  scene.add(rig);
  return rig;
}
