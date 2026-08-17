/**
 * Rocket Arena — Client Entry Point
 *
 * Bootstraps renderer, connects to server, and presents synchronized entities.
 */

import { initScene } from './renderer/scene.js';
import { createLighting } from './renderer/lighting.js';
import { createArena } from './renderer/arena.js';
import { getRoom } from './networking/client.js';
import {
  getBallMesh,
  getCarMeshes,
  getLocalState,
  updateInterpolatedEntities,
} from './networking/state-listener.js';
import { getCurrentInput, sendInput } from './input/keyboard-handler.js';
import { createHUD, updateHUD } from './hud/hud.js';
import { createDevPanel } from './dev-panel/dev-panel.js';
import { createLobby } from './ui/lobby.js';
import { showGameOver } from './ui/game-over.js';
import { updateCamera, setFollowMode, setOrbitMode } from './renderer/camera-controller.js';
import { updateEntityEffects } from './renderer/entity-effects.js';
import { initializeAudio, updateAudio } from './audio/audio-manager.js';
import type { Room } from 'colyseus.js';

const app = document.getElementById('app')!;
const { renderer, scene, camera } = initScene(app);
createLighting(scene);
createArena(scene);
createHUD();
initializeAudio();

let gameEnded = false;
let previousFrameTime = performance.now() / 1000;

setOrbitMode();

createLobby((room: Room) => {
  createDevPanel(room);
  gameEnded = false;
  setFollowMode();
  console.log('[Rocket Arena] Connected and playing');
}, scene);

function animate(): void {
  requestAnimationFrame(animate);

  const frameNowMs = performance.now();
  const time = frameNowMs / 1000;
  const deltaSeconds = Math.min(Math.max(time - previousFrameTime, 0), 0.1);
  previousFrameTime = time;
  const room = getRoom();
  sendInput(room);

  if (room) {
    updateInterpolatedEntities(frameNowMs);
    updateHUD(room);
    updateEntityEffects(deltaSeconds, time);

    const localCar = getCarMeshes().get(room.sessionId) || null;
    const state = getLocalState();
    updateCamera(camera, localCar, time, deltaSeconds);
    updateAudio({
      roomId: room.id,
      sessionId: room.sessionId,
      state,
      input: getCurrentInput(),
      localCar,
      ball: getBallMesh(),
      camera,
      deltaSeconds,
      nowMs: frameNowMs,
    });

    if (!gameEnded && state?.phase === 'ended') {
      gameEnded = true;
      setTimeout(() => showGameOver(room), 2000);
    }
  } else {
    updateCamera(camera, null, time, deltaSeconds);
    updateAudio({
      roomId: null,
      sessionId: null,
      state: null,
      input: getCurrentInput(),
      localCar: null,
      ball: null,
      camera,
      deltaSeconds,
      nowMs: frameNowMs,
    });
  }

  renderer.render(scene, camera);
}

animate();
console.log('[Rocket Arena] Client initialized');
