/**
 * Rocket Arena — Client Entry Point
 *
 * Bootstraps renderer, connects to server, renders entities from state.
 */

import { initScene } from './renderer/scene.js';
import { createLighting } from './renderer/lighting.js';
import { createArena } from './renderer/arena.js';
import { getRoom } from './networking/client.js';
import {
  getCarMeshes,
  getLocalState,
  updateInterpolatedEntities,
} from './networking/state-listener.js';
import { sendInput } from './input/keyboard-handler.js';
import { createHUD, updateHUD } from './hud/hud.js';
import { createDevPanel } from './dev-panel/dev-panel.js';
import { createLobby } from './ui/lobby.js';
import { showGameOver } from './ui/game-over.js';
import { updateCamera, setFollowMode, setOrbitMode } from './renderer/camera-controller.js';
import type { Room } from 'colyseus.js';

const app = document.getElementById('app')!;

// Initialize Three.js
const { renderer, scene, camera } = initScene(app);
createLighting(scene);
createArena(scene);

// Create HUD (hidden until game starts)
createHUD();

// Track game-over state
let gameEnded = false;

// Show lobby — camera starts in orbit mode
setOrbitMode();

createLobby((room: Room) => {
  // Called when phase transitions to 'playing' — game is live
  // setupStateListener was already called in lobby when the room was joined
  createDevPanel(room);
  gameEnded = false;

  // Switch camera to follow mode for gameplay
  setFollowMode();

  console.log('[Rocket Arena] Connected and playing');
}, scene);

// Render loop
function animate() {
  requestAnimationFrame(animate);

  const frameNowMs = performance.now();
  const time = frameNowMs / 1000;
  const room = getRoom();

  if (room) {
    sendInput(room);
    updateInterpolatedEntities(frameNowMs);
    updateHUD(room);

    // Camera follows local player's car
    const localCar = getCarMeshes().get(room.sessionId) || null;
    updateCamera(camera, localCar, time);

    // Check for game end via local state
    const state = getLocalState();
    if (!gameEnded && state?.phase === 'ended') {
      gameEnded = true;
      setTimeout(() => showGameOver(room), 2000);
    }
  } else {
    updateCamera(camera, null, time);
  }

  renderer.render(scene, camera);
}

animate();
console.log('[Rocket Arena] Client initialized');
