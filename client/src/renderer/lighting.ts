import * as THREE from 'three';

/**
 * Stadium-style dramatic lighting with floodlights and goal accent lights.
 */
export function createLighting(scene: THREE.Scene): void {
  // Ambient — slightly stronger for overall visibility
  const ambient = new THREE.AmbientLight(0xffffff, 0.5);
  scene.add(ambient);

  // Main directional (sun/floodlight from above)
  const sun = new THREE.DirectionalLight(0xffffff, 0.9);
  sun.position.set(10, 45, -5);
  sun.castShadow = true;
  sun.shadow.mapSize.width = 2048;
  sun.shadow.mapSize.height = 2048;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 120;
  sun.shadow.camera.left = -45;
  sun.shadow.camera.right = 45;
  sun.shadow.camera.top = 45;
  sun.shadow.camera.bottom = -45;
  scene.add(sun);

  // Stadium floodlights (4 point lights from above corners)
  const floodColor = 0xeeeeff;
  const floodIntensity = 0.6;
  const floodDist = 60;

  const flood1 = new THREE.PointLight(floodColor, floodIntensity, floodDist);
  flood1.position.set(-15, 25, -20);
  scene.add(flood1);

  const flood2 = new THREE.PointLight(floodColor, floodIntensity, floodDist);
  flood2.position.set(15, 25, -20);
  scene.add(flood2);

  const flood3 = new THREE.PointLight(floodColor, floodIntensity, floodDist);
  flood3.position.set(-15, 25, 20);
  scene.add(flood3);

  const flood4 = new THREE.PointLight(floodColor, floodIntensity, floodDist);
  flood4.position.set(15, 25, 20);
  scene.add(flood4);

  // Blue goal light (stronger, closer)
  const blueLight = new THREE.PointLight(0x3366ff, 1.5, 25);
  blueLight.position.set(0, 3, -30);
  scene.add(blueLight);

  // Orange goal light (stronger, closer)
  const orangeLight = new THREE.PointLight(0xff6633, 1.5, 25);
  orangeLight.position.set(0, 3, 30);
  scene.add(orangeLight);

  // Subtle rim/uplighting from below center (gives arena depth)
  const rimLight = new THREE.PointLight(0x6644ff, 0.3, 30);
  rimLight.position.set(0, -2, 0);
  scene.add(rimLight);
}
