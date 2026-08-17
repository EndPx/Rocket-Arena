import * as THREE from 'three';
import { VISUAL } from '@rocket-arena/shared';

let renderer: THREE.WebGLRenderer;
let scene: THREE.Scene;
let camera: THREE.PerspectiveCamera;

function viewportPixelRatio(): number {
  return Math.min(window.devicePixelRatio || 1, VISUAL.RENDER.MAX_PIXEL_RATIO);
}

export function initScene(container: HTMLElement): {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
} {
  renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
  });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(viewportPixelRatio());
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = VISUAL.RENDER.EXPOSURE;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.setClearColor(VISUAL.PALETTE.SKY, 1);
  renderer.domElement.style.display = 'block';
  renderer.domElement.setAttribute('aria-label', 'Rocket Arena game view');
  container.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(VISUAL.PALETTE.SKY);
  scene.fog = new THREE.Fog(
    VISUAL.PALETTE.FOG,
    VISUAL.RENDER.FOG_NEAR,
    VISUAL.RENDER.FOG_FAR,
  );

  camera = new THREE.PerspectiveCamera(
    VISUAL.CAMERA.FOV_MIN,
    window.innerWidth / window.innerHeight,
    VISUAL.RENDER.CAMERA_NEAR,
    VISUAL.RENDER.CAMERA_FAR,
  );
  camera.position.set(0, VISUAL.CAMERA.ORBIT_HEIGHT, -VISUAL.CAMERA.ORBIT_RADIUS_Z);
  camera.lookAt(0, VISUAL.CAMERA.ORBIT_LOOK_HEIGHT, 0);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(viewportPixelRatio());
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  return { renderer, scene, camera };
}

export function getRenderer(): THREE.WebGLRenderer {
  return renderer;
}

export function getScene(): THREE.Scene {
  return scene;
}

export function getCamera(): THREE.PerspectiveCamera {
  return camera;
}
