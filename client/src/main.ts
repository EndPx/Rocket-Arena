/**
 * Rocket Arena — Client Entry Point
 *
 * Bootstraps renderer, connects to server, renders entities from state.
 */

import { initScene } from './renderer/scene.js';
import { createLighting } from './renderer/lighting.js';
import { createArena } from './renderer/arena.js';
import { joinSandbox, getRoom } from './networking/client.js';
import { setupStateListener } from './networking/state-listener.js';
import { sendInput } from './input/keyboard-handler.js';

const app = document.getElementById('app')!;

// Initialize Three.js
const { renderer, scene, camera } = initScene(app);
createLighting(scene);
createArena(scene);

// Connect to server
async function connect() {
  try {
    const room = await joinSandbox('Player');
    setupStateListener(room, scene);
    console.log('[Rocket Arena] Connected to sandbox room');
  } catch (e) {
    console.warn('[Rocket Arena] Could not connect to server:', e);
    console.log('[Rocket Arena] Running in offline mode (arena visible, no multiplayer)');
  }
}

connect();

// Render loop
function animate() {
  requestAnimationFrame(animate);

  // Send input every frame
  sendInput(getRoom());

  renderer.render(scene, camera);
}
animate();

console.log('[Rocket Arena] Client initialized');
