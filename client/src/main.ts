/**
 * Rocket Arena — Client Entry Point
 *
 * Bootstraps renderer, connects to server, and presents synchronized entities.
 */

import {
  RESOLVED_ARENA_GEOMETRY,
  resolveBoostPadDescriptors,
} from '@rocket-arena/shared';
import { initScene } from './renderer/scene.js';
import { createLighting } from './renderer/lighting.js';
import { createArena } from './renderer/arena.js';
import { createBallFieldMarker } from './renderer/ball-field-marker.js';
import { createBoostPadVisuals } from './renderer/boost-pads.js';
import { getRoom } from './networking/client.js';
import { acceptedSnapshotStore } from './networking/accepted-snapshot-store.js';
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
import { createHUD, destroyHUD, resetHUD, updateHUD } from './hud/hud.js';
import {
  projectBallIndicator,
  type BallIndicatorProjection,
} from './hud/ball-indicator.js';
import { createDevPanel } from './dev-panel/dev-panel.js';
import { createLobby, showLobby } from './ui/lobby.js';
import { showGameOver } from './ui/game-over.js';
import { createPauseMenu, destroyPauseMenu } from './ui/pause-menu.js';
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
createLighting(scene, resolvedArenaGeometry);
const arena = createArena(scene, resolvedArenaGeometry);
const ballFieldMarker = createBallFieldMarker();
scene.add(ballFieldMarker.object);
// Descriptor-driven and read from the same shared table the room grants from, so
// a drawn pad is always a pad that pays out.
const boostPads = createBoostPadVisuals(resolveBoostPadDescriptors());
scene.add(boostPads.object);
createHUD();
initializeAudio();

/** Client-only presentation toggle owned by the settings panel. */
let ballMarkerVisible = true;

createPauseMenu({
  isInMatch: () => getRoom() !== null,
  returnToLobby: () => {
    getRoom()?.leave();
    showLobby();
  },
  applyBallMarkerVisible: (visible) => {
    ballMarkerVisible = visible;
    if (!visible) ballFieldMarker.update(null);
  },
});

let gameEnded = false;
let previousFrameTime = performance.now() / 1000;

/** Indicator centres stay clear of the protected central region of the view. */
const BALL_INDICATOR_INSET_RATIO = 0.11;

interface PresentedBall {
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
}

function projectOffscreenBall(ball: PresentedBall | null): BallIndicatorProjection | null {
  if (!ball) return null;
  const width = renderer.domElement.clientWidth;
  const height = renderer.domElement.clientHeight;
  if (width <= 0 || height <= 0) return null;

  camera.updateMatrixWorld();
  return projectBallIndicator({
    worldPosition: ball.position,
    viewMatrix: camera.matrixWorldInverse,
    projectionMatrix: camera.projectionMatrix,
    viewport: {
      width,
      height,
      insetX: width * BALL_INDICATOR_INSET_RATIO,
      insetY: height * BALL_INDICATOR_INSET_RATIO,
    },
  });
}

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
  // Pad cooldowns are authoritative, so they are read from the acceptance
  // boundary rather than timed locally. No accepted snapshot means nothing is
  // known to be spent, which draws every pad available.
  boostPads.update(time, acceptedSnapshotStore.getSnapshot()?.boostPadCooldowns);
  const room = getRoom();
  sendInput(room);

  if (room) {
    // One presentation order: accepted/interpolated state, entity effects,
    // camera, HUD, audio, then render.
    const presentedFrame = updateInterpolatedEntities(frameNowMs);
    updateEntityEffects(deltaSeconds, time);

    const localCar = getCarMeshes().get(room.sessionId) || null;
    const ball = getBallMesh();
    // The field circle is a floor overlay, not a snapshot entity, so it simply
    // follows whichever ball currently exists and hides when there is none.
    ballFieldMarker.update(ballMarkerVisible && ball ? ball.position : null);
    const state = getLocalState();
    const inputCommand = getCurrentInputCommandV2();
    const activePlay = state?.phase === 'playing' || state?.phase === 'overtime';
    updateCamera(camera, localCar, time, deltaSeconds, {
      ball,
      activePlay,
      cameraToggleSequence: inputCommand.cameraToggleSequence,
      presentedKickoffEpoch: presentedFrame?.kickoffEpoch ?? null,
    });
    updateHUD({
      cameraMode: getCameraMode(),
      ballIndicator: projectOffscreenBall(ball),
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
    resetHUD();
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

const disposeClient = (): void => {
  destroyPauseMenu();
  boostPads.dispose();
  ballFieldMarker.dispose();
  arena.dispose();
  destroyHUD();
};
window.addEventListener('pagehide', disposeClient, { once: true });
window.addEventListener('beforeunload', disposeClient, { once: true });

animate();
console.log('[Rocket Arena] Client initialized');
