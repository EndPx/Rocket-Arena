import * as THREE from 'three';
import type { Room } from 'colyseus.js';
import { createCarMesh } from '../renderer/car.js';
import { createBallMesh } from '../renderer/ball.js';

const carMeshes: Map<string, THREE.Group> = new Map();
let ballMesh: THREE.Mesh | null = null;

/**
 * Set up state change listeners on the room.
 * Creates/removes car meshes on player add/remove.
 * Updates positions/rotations each state change.
 */
export function setupStateListener(room: Room, scene: THREE.Scene): void {
  // Create ball mesh
  ballMesh = createBallMesh();
  scene.add(ballMesh);

  // Helper to add a car (idempotent — skips if already added)
  function addCar(player: any, sessionId: string) {
    if (carMeshes.has(sessionId)) return; // Already added
    const carMesh = createCarMesh(player.team);
    carMesh.position.set(player.x, player.y, player.z);
    carMesh.quaternion.set(player.qx, player.qy, player.qz, player.qw);
    scene.add(carMesh);
    carMeshes.set(sessionId, carMesh);
    console.log(`[State] Car added: ${sessionId} (${player.team})`);

    // Listen for changes on this player
    player.onChange(() => {
      const mesh = carMeshes.get(sessionId);
      if (mesh) {
        mesh.position.set(player.x, player.y, player.z);
        mesh.quaternion.set(player.qx, player.qy, player.qz, player.qw);
      }
    });
  }

  // Listen for future player adds
  room.state.players.onAdd((player: any, sessionId: string) => {
    addCar(player, sessionId);
  });

  // Handle players that already exist in state (race condition fix)
  room.state.players.forEach((player: any, sessionId: string) => {
    addCar(player, sessionId);
  });

  // Listen for player remove
  room.state.players.onRemove((_player: any, sessionId: string) => {
    const mesh = carMeshes.get(sessionId);
    if (mesh) {
      scene.remove(mesh);
      carMeshes.delete(sessionId);
      console.log(`[State] Car removed: ${sessionId}`);
    }
  });

  // Listen for ball state changes
  room.state.ball.onChange(() => {
    if (ballMesh) {
      const ball = room.state.ball;
      ballMesh.position.set(ball.x, ball.y, ball.z);
      ballMesh.quaternion.set(ball.qx, ball.qy, ball.qz, ball.qw);
    }
  });

  // Also update ball position immediately from current state
  if (room.state.ball) {
    const ball = room.state.ball;
    ballMesh.position.set(ball.x, ball.y, ball.z);
    ballMesh.quaternion.set(ball.qx, ball.qy, ball.qz, ball.qw);
  }
}

export function getCarMeshes(): ReadonlyMap<string, THREE.Group> {
  return carMeshes;
}

export function getBallMesh(): THREE.Mesh | null {
  return ballMesh;
}
