/**
 * Rocket Arena — Client Entry Point
 *
 * Bootstraps renderer, connects to server, renders entities from state.
 */

import { initScene } from './renderer/scene.js';
import { createLighting } from './renderer/lighting.js';
import { createArena } from './renderer/arena.js';
import { getRoom } from './networking/client.js';
import { setupStateListener } from './networking/state-listener.js';
import { sendInput } from './input/keyboard-handler.js';
import { createHUD, updateHUD } from './hud/hud.js';
import { createDevPanel } from './dev-panel/dev-panel.js';
import { createLobby } from './ui/lobby.js';
import type { Room } from 'colyseus.js';

const app = document.getElementById('app')!;

// Initialize Three.js
const { renderer, scene, camera } = initScene(app);
createLighting(scene);
createArena(scene);

// Create HUD (hidden until game starts)
createHUD();

// Show lobby
createLobby((room: Room) => {
  // On successful join
  setupStateListener(room, scene);
  createDevPanel(room);
  console.log('[Rocket Arena] Connected and playing');
});

// Render loop
function animate() {
  requestAnimationFrame(animate);

  const room = getRoom();
  if (room) {
    sendInput(room);
    updateHUD(room);
  }

  renderer.render(scene, camera);
}
animate();

console.log('[Rocket Arena] Client initialized');
