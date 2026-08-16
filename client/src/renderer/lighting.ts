import * as THREE from 'three';

export function createLighting(scene: THREE.Scene): void {
  // Ambient
  const ambient = new THREE.AmbientLight(0xffffff, 0.4);
  scene.add(ambient);

  // Main directional (sun)
  const sun = new THREE.DirectionalLight(0xffffff, 0.8);
  sun.position.set(20, 40, -10);
  sun.castShadow = true;
  sun.shadow.mapSize.width = 2048;
  sun.shadow.mapSize.height = 2048;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 100;
  sun.shadow.camera.left = -40;
  sun.shadow.camera.right = 40;
  sun.shadow.camera.top = 40;
  sun.shadow.camera.bottom = -40;
  scene.add(sun);

  // Blue goal light
  const blueLight = new THREE.PointLight(0x3366ff, 1, 20);
  blueLight.position.set(0, 3, -30);
  scene.add(blueLight);

  // Orange goal light
  const orangeLight = new THREE.PointLight(0xff6633, 1, 20);
  orangeLight.position.set(0, 3, 30);
  scene.add(orangeLight);
}
