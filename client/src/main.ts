/**
 * Rocket Arena — Client Entry Point
 *
 * Bootstraps renderer, connects to server, and presents synchronized entities.
 */

import { RESOLVED_ARENA_GEOMETRY } from '@rocket-arena/shared';
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
import {
  getCurrentInput,
  getCurrentInputCommandV2,
  sendInput,
} from './input/keyboard-handler.js';
import { createHUD, updateHUD } from './hud/hud.js';
import { createDevPanel } from './dev-panel/dev-panel.js';
import { createLobby } from './ui/lobby.js';
import { showGameOver } from './ui/game-over.js';
import {
  beginGameplayCameraSession,
  getCameraMode,
  setOrbitMode,
  updateCamera,
} from './renderer/camera-controller.js';
import { updateEntityEffects } from './renderer/entity-effects.js';
import { initializeAudio, updateAudio } from './audio/audio-manager.js';
import type { Room } from 'colyseus.js';

const app = document.getElementById('app')!;
const { renderer, scene, camera } = initScene(app);
const resolvedArenaGeometry = RESOLVED_ARENA_GEOMETRY;
createLighting(scene);
const arena = createArena(scene, resolvedArenaGeometry);
createHUD();
initializeAudio();

let gameEnded = false;
let previousFrameTime = performance.now() / 1000;

setOrbitMode();

createLobby((room: Room) => {
  createDevPanel(room);
  gameEnded = false;
  beginGameplayCameraSession(getCurrentInputCommandV2().cameraToggleSequence);
  console.log('[Rocket Arena] Connected and playing');
}, scene);

function animate(): void {
  requestAnimationFrame(animate);

  const frameNowMs = performance.now();
  const time = frameNowMs / 1000;
  const deltaSeconds = Math.min(Math.max(time - previousFrameTime, 0), 0.1);
  previousFrameTime = time;
  arena.update(deltaSeconds, time);
  const room = getRoom();
  sendInput(room);

  if (room) {
    const presentedFrame = updateInterpolatedEntities(frameNowMs);
    updateHUD(room);
    updateEntityEffects(deltaSeconds, time);

    const localCar = getCarMeshes().get(room.sessionId) || null;
    const ball = getBallMesh();
    const state = getLocalState();
    const inputCommand = getCurrentInputCommandV2();
    const activePlay = state?.phase === 'playing' || state?.phase === 'overtime';
    updateCamera(camera, localCar, time, deltaSeconds, {
      ball,
      activePlay,
      cameraToggleSequence: inputCommand.cameraToggleSequence,
      presentedKickoffEpoch: presentedFrame?.kickoffEpoch ?? null,
    });
    updateAudio({
      roomId: room.id,
      sessionId: room.sessionId,
      state,
      input: getCurrentInput(),
      localCar,
      ball,
      camera,
      deltaSeconds,
      nowMs: frameNowMs,
    });

    if (!gameEnded && state?.phase === 'ended') {
      gameEnded = true;
      setTimeout(() => showGameOver(room), 2000);
    }
  } else {
    if (getCameraMode() !== 'orbit') setOrbitMode();
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

const disposeArena = (): void => arena.dispose();
window.addEventListener('pagehide', disposeArena, { once: true });
window.addEventListener('beforeunload', disposeArena, { once: true });

animate();
console.log('[Rocket Arena] Client initialized');
