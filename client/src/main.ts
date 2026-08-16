/**
 * Rocket Arena — Client Entry Point
 *
 * Bootstraps the Three.js renderer, arena geometry, and lighting.
 * Networking, input handling, and HUD will be added in subsequent tasks.
 */

import { initScene } from './renderer/scene.js';
import { createLighting } from './renderer/lighting.js';
import { createArena } from './renderer/arena.js';

const app = document.getElementById('app')!;

// Initialize Three.js
const { renderer, scene, camera } = initScene(app);
createLighting(scene);
createArena(scene);

// Render loop
function animate() {
  requestAnimationFrame(animate);
  renderer.render(scene, camera);
}
animate();

console.log('[Rocket Arena] Client initialized — arena rendered');
